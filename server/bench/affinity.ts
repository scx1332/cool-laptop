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

/** Kills a process and everything it spawned.
 *
 * The load generator is a parent of one burn process per thread. Killing only
 * the parent leaves those children running at full tilt until their duration
 * expires, which is exactly the wrong response to someone pressing cancel. */
export async function killTree(pid: number): Promise<void> {
  const proc = Bun.spawn(['taskkill.exe', '/PID', String(pid), '/T', '/F'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
}

export function maskToHex(mask: number): string {
  return '0x' + mask.toString(16).toUpperCase();
}
