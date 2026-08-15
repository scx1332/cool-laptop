# Long-lived telemetry sidecar. Emits one compact JSON line per interval on
# stdout, forever, until killed.
#
# Why a persistent process: Get-Counter costs roughly a second of startup per
# invocation, so sampling by spawning a process per tick can never hit 1 Hz.
# Instead we hold System.Diagnostics.PerformanceCounter objects open and call
# NextValue(), which is a cheap shared-memory read.
#
# Units: the Energy Meter counters report milliwatts; we convert to watts.

param([int]$IntervalMs = 1000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function New-Counter($category, $counter, $instance) {
    try {
        $pc = New-Object System.Diagnostics.PerformanceCounter($category, $counter, $instance, $true)
        [void]$pc.NextValue()   # prime: rate counters need two reads
        return $pc
    } catch {
        return $null
    }
}

# ---- CPU counters, one set per logical processor -------------------------
$procCat = New-Object System.Diagnostics.PerformanceCounterCategory('Processor Information')
$instances = $procCat.GetInstanceNames() |
    Where-Object { $_ -notmatch '_Total' } |
    Sort-Object { [int](($_ -split ',')[1]) }

$cpu = @()
foreach ($inst in $instances) {
    $cpu += [pscustomobject]@{
        Id      = [int](($inst -split ',')[1])
        Perf    = New-Counter 'Processor Information' '% Processor Performance' $inst
        Util    = New-Counter 'Processor Information' '% Processor Utility' $inst
        Parked  = New-Counter 'Processor Information' 'Parking Status' $inst
        Limit   = New-Counter 'Processor Information' '% Performance Limit' $inst
        Flags   = New-Counter 'Processor Information' 'Performance Limit Flags' $inst
    }
}
$cpu = $cpu | Sort-Object Id

# ---- RAPL power counters -------------------------------------------------
$pkg  = New-Counter 'Energy Meter' 'Power' 'rapl_package0_pkg'
$pp0  = New-Counter 'Energy Meter' 'Power' 'rapl_package0_pp0'
$pp1  = New-Counter 'Energy Meter' 'Power' 'rapl_package0_pp1'
$dram = New-Counter 'Energy Meter' 'Power' 'rapl_package0_dram'

function Read-Watts($c) { if ($null -eq $c) { 0.0 } else { [math]::Round($c.NextValue() / 1000.0, 2) } }

# ---- AC/battery state ----------------------------------------------------
Add-Type -Namespace PM -Name Pwr -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SPS { public byte ACLineStatus; public byte BatteryFlag;
                    public byte BatteryLifePercent; public byte SystemStatusFlag;
                    public int BatteryLifeTime; public int BatteryFullLifeTime; }
[DllImport("kernel32.dll")]
public static extern bool GetSystemPowerStatus(out SPS s);
'@

function Test-OnAc {
    $s = New-Object PM.Pwr+SPS
    if ([PM.Pwr]::GetSystemPowerStatus([ref]$s)) { return ($s.ACLineStatus -eq 1) }
    return $true
}

# Signal readiness so the parent knows counters are primed.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $tick = $sw.ElapsedMilliseconds

    $cores = foreach ($c in $cpu) {
        $perf = if ($c.Perf) { [math]::Round($c.Perf.NextValue(), 1) } else { 0 }
        $util = if ($c.Util) { [math]::Round($c.Util.NextValue(), 1) } else { 0 }
        $park = if ($c.Parked) { [int]$c.Parked.NextValue() } else { 0 }
        $lim  = if ($c.Limit) { [math]::Round($c.Limit.NextValue(), 1) } else { 100 }
        $flag = if ($c.Flags) { [int]$c.Flags.NextValue() } else { 0 }
        @($c.Id, $perf, $util, $park, $lim, $flag)
    }

    # cpus is a flat array packed 6 values per core, in ascending core id:
    #   [id, perf, util, parked, limit, flags, id, perf, ...]
    # Flat keeps the line roughly a third the size of nested arrays, which
    # matters at 1 Hz with 20 cores.
    $payload = [ordered]@{
        t    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        pkg  = Read-Watts $pkg
        pp0  = Read-Watts $pp0
        pp1  = Read-Watts $pp1
        dram = Read-Watts $dram
        ac   = [int](Test-OnAc)
        cpus = @($cores)
    }

    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()

    $elapsed = $sw.ElapsedMilliseconds - $tick
    $sleep = $IntervalMs - $elapsed
    if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}
