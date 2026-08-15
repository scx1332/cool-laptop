# Emits the CPU topology as JSON: one entry per logical processor with its
# efficiency class and physical core index.
#
# Uses GetSystemCpuSetInformation, a documented userspace Win32 API. No driver,
# no MSR access. EfficiencyClass 0 is the least performant class (E-cores);
# the highest class is the P-cores.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace PM -Name CpuSets -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetSystemCpuSetInformation(
    IntPtr Information, uint BufferLength, out uint ReturnedLength,
    IntPtr Process, uint Flags);
'@

$needed = 0
[void][PM.CpuSets]::GetSystemCpuSetInformation([IntPtr]::Zero, 0, [ref]$needed, [IntPtr]::Zero, 0)
if ($needed -le 0) { throw 'GetSystemCpuSetInformation reported no data' }

$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$needed)
try {
    $written = 0
    if (-not [PM.CpuSets]::GetSystemCpuSetInformation($buf, [uint32]$needed, [ref]$written, [IntPtr]::Zero, 0)) {
        throw "GetSystemCpuSetInformation failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }

    $bytes = New-Object byte[] $written
    [System.Runtime.InteropServices.Marshal]::Copy($buf, $bytes, 0, [int]$written)

    # SYSTEM_CPU_SET_INFORMATION field offsets within each record.
    $CPUSET_TYPE = 0
    $out = New-Object System.Collections.Generic.List[object]
    $off = 0
    while ($off -lt $written) {
        $size = [BitConverter]::ToUInt32($bytes, $off)
        if ($size -lt 32) { break }
        $type = [BitConverter]::ToUInt32($bytes, $off + 4)
        if ($type -eq $CPUSET_TYPE) {
            $out.Add([pscustomobject]@{
                id         = [int]$bytes[$off + 14]   # LogicalProcessorIndex
                core       = [int]$bytes[$off + 15]   # CoreIndex
                cache      = [int]$bytes[$off + 16]   # LastLevelCacheIndex
                effClass   = [int]$bytes[$off + 18]   # EfficiencyClass
                group      = [int][BitConverter]::ToUInt16($bytes, $off + 12)
                # AllFlags bit layout: 0 = Parked, 1 = Allocated,
                # 2 = AllocatedToTargetProcess, 3 = RealTime.
                parked     = (($bytes[$off + 19] -band 0x01) -ne 0)
                allocated  = (($bytes[$off + 19] -band 0x02) -ne 0)
            })
        }
        $off += [int]$size
    }

    $out | Sort-Object id | ConvertTo-Json -Compress -Depth 4
}
finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
}
