<#
.SYNOPSIS
    Installs (or updates, or removes) PowerManagement as a Windows service.

.DESCRIPTION
    Copies the compiled single executable to a stable location and registers it
    with NSSM as a LocalSystem service starting at boot.

    Why NSSM: the executable is an ordinary console program, and Windows kills
    anything registered with `sc create` that does not answer the service
    control protocol within thirty seconds. NSSM is that missing half.

    Why LocalSystem: powercfg writes to a power scheme need administrator
    rights, and a service that asks a logged-in user for them is a service that
    does not start at boot.

    Why a copy rather than the build output: rebuilding while the service runs
    fails outright, because Windows holds a lock on a running executable.

    Stopping the service sends Ctrl-C rather than killing the process, so the
    server's own shutdown path runs: stock settings restored, original power
    scheme reactivated.

.PARAMETER Action
    install (default), uninstall, or status.

.PARAMETER RestoreLast
    Re-apply the settings last chosen in the UI when the service starts, so a
    frequency cap survives a reboot. Without it every boot starts at stock, and
    the lab scheme is explicitly cleared on the way up rather than inherited.

    The client watchdog is disabled either way — unattended is the intended
    state for a service, so "no browser tab is open" must not mean "someone
    forgot, undo everything".

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -RestoreLast
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall', 'status')]
    [string]$Action = 'install',

    [switch]$RestoreLast,

    [string]$ServiceName = 'PowerManagement',
    [string]$InstallDir = "$env:ProgramFiles\PowerManagement",
    [int]$Port = 4317
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'dist\powermanagement.exe'
$target = Join-Path $InstallDir 'powermanagement.exe'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell: registering a service and writing power schemes both need administrator rights.'
    }
}

function Get-Nssm {
    $cmd = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw 'nssm was not found on PATH. Install it (winget install NSSM.NSSM) and try again.'
    }
    return $cmd.Source
}

function Show-Status {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "$ServiceName is not installed."
        return
    }
    $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    [pscustomobject]@{
        Name      = $svc.Name
        Status    = $svc.Status
        StartType = $wmi.StartMode
        Account   = $wmi.StartName
        Path      = $wmi.PathName
    } | Format-List
}

Assert-Admin

switch ($Action) {
    'status' {
        Show-Status
        break
    }

    'uninstall' {
        $nssm = Get-Nssm
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            # Stop first so the server restores stock settings on the way out.
            & $nssm stop $ServiceName confirm | Out-Null
            Start-Sleep -Seconds 3
            & $nssm remove $ServiceName confirm | Out-Null
            Write-Host "Removed service $ServiceName."
        } else {
            Write-Host "$ServiceName is not installed."
        }
        break
    }

    'install' {
        $nssm = Get-Nssm
        if (-not (Test-Path $source)) {
            throw "No executable at $source. Build it first: bun run build:exe"
        }

        # An already-installed service holds a lock on its own binary.
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            Write-Host "Stopping existing $ServiceName for update..."
            & $nssm stop $ServiceName confirm | Out-Null
            Start-Sleep -Seconds 3
        }

        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
        Copy-Item $source $target -Force
        Write-Host "Installed executable to $target"

        if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
            & $nssm install $ServiceName $target | Out-Null
        } else {
            & $nssm set $ServiceName Application $target | Out-Null
        }

        # Data — the state file, and the database if one is asked for on disk —
        # lands next to the executable, so that is the working directory.
        & $nssm set $ServiceName AppDirectory $InstallDir | Out-Null
        & $nssm set $ServiceName DisplayName 'PowerManagement CPU governor' | Out-Null
        & $nssm set $ServiceName Description 'Local CPU power and frequency control with telemetry, on http://localhost:4317' | Out-Null
        & $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
        & $nssm set $ServiceName ObjectName LocalSystem | Out-Null
        & $nssm set $ServiceName AppNoConsole 0 | Out-Null

        # Ctrl-C, generously timed: the shutdown path spends several seconds in
        # powercfg putting the machine back to stock, and being killed halfway
        # through leaves a capped CPU behind.
        & $nssm set $ServiceName AppStopMethodConsole 20000 | Out-Null
        & $nssm set $ServiceName AppStopMethodWindow 5000 | Out-Null
        & $nssm set $ServiceName AppStopMethodThreads 5000 | Out-Null

        & $nssm set $ServiceName AppStdout (Join-Path $InstallDir 'logs\service.log') | Out-Null
        & $nssm set $ServiceName AppStderr (Join-Path $InstallDir 'logs\service.log') | Out-Null
        & $nssm set $ServiceName AppRotateFiles 1 | Out-Null
        & $nssm set $ServiceName AppRotateBytes 5242880 | Out-Null

        # One argument per variable. Joining them into a single string instead
        # produces one variable whose value is the rest of the line, which fails
        # silently: PM_PORT parses as NaN and the server binds a random port.
        # The watchdog is always off for a service, whether or not settings are
        # restored at boot. It exists so a forgotten cap cannot outlive the tab
        # that set it, which is the right instinct for a program you launch in a
        # terminal and the wrong one here: a service is meant to be unattended,
        # and "no browser tab is open" must not come to mean "someone forgot,
        # undo everything" while the machine is simply being used.
        $envVars = @("PM_PORT=$Port", 'PM_WATCHDOG_MS=0')
        if ($RestoreLast) {
            $envVars += 'PM_RESTORE_LAST=1'
        }
        & $nssm set $ServiceName AppEnvironmentExtra @envVars | Out-Null

        & $nssm start $ServiceName | Out-Null
        Start-Sleep -Seconds 8
        Show-Status
        Write-Host "Settings restored on start: $([bool]$RestoreLast). Logs: $InstallDir\logs\service.log"
    }
}
