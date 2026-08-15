/**
 * Sets the processor affinity of an already-running process.
 *
 * Windows exposes this through Process.ProcessorAffinity, which is reachable
 * from PowerShell without any driver or elevation beyond owning the process.
 */
export async function setProcessAffinity(pid: number, mask: number): Promise<void> {
  const proc = Bun.spawn(
    [
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = [IntPtr]${mask}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`failed to set affinity on pid ${pid}: ${err}`);
}

export function maskToHex(mask: number): string {
  return '0x' + mask.toString(16).toUpperCase();
}
