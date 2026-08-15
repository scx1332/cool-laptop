import { setClassValue, activate } from './powercfg.ts';
import type { Settings } from '../types.ts';

/**
 * Re-asserts frequency caps on a timer.
 *
 * Measured on this Latitude: a frequency cap written with powercfg is silently
 * reset to 0 within about ten seconds. Polling the stored value shows it go
 * 1200 -> 0 on its own with nothing else running, and once it is zeroed the
 * cores boost freely again. Intel's Innovation Platform Framework / Dynamic
 * Tuning services (ipfsvc, dptftcs) own the platform's power policy on Dell
 * hardware and rewrite it underneath us.
 *
 * Fighting that turns out to be simple and effective: write the cap again
 * every couple of seconds. With a keeper running, an all-core load holds a
 * 1200 MHz cap at a steady 1178 MHz indefinitely; without it, the same cap
 * lasts a few seconds and then stops applying. This is the difference between
 * the controls in this app being reliable and being a coin flip.
 *
 * Only the frequency caps are re-asserted. They are the values observed to be
 * wiped, and each pass costs five powercfg invocations — re-writing the whole
 * settings block this often would be far more expensive for no benefit.
 */
export class CapKeeper {
  private scheme: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** Caps requested by the settings panel. */
  private desired: { p: number; e: number } = { p: 0, e: 0 };
  /** When the governor is driving, its cap wins over the panel's. */
  private governorCap: number | null = null;

  /** 1.5s costs five powercfg spawns per pass and keeps the escape window
   *  short. At 2.5s a wiped cap let an all-core load jump from 1178 to
   *  1545 MHz for a full sample before being pulled back. */
  intervalMs = 1500;
  lastAssertAt = 0;
  /** Calibration drives the caps itself; the keeper must not overwrite them
   *  mid-measurement or every reading becomes garbage. */
  private suspended = false;

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  start(schemeGuid: string): void {
    this.scheme = schemeGuid;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setDesired(s: Settings): void {
    this.desired = { p: s.p.freqMax, e: s.e.freqMax };
  }

  setGovernorCap(mhz: number | null): void {
    this.governorCap = mhz;
  }

  private effective(): { p: number; e: number } {
    if (this.governorCap != null) return { p: this.governorCap, e: this.governorCap };
    return this.desired;
  }

  /** Nothing to defend when no cap is requested — stay off the CPU entirely. */
  private needed(): boolean {
    const e = this.effective();
    return e.p !== 0 || e.e !== 0;
  }

  private async tick(): Promise<void> {
    if (!this.scheme || this.busy || this.suspended || !this.needed()) return;
    this.busy = true;
    try {
      const { p, e } = this.effective();
      await setClassValue(this.scheme, 1, 'freqMax', p);
      await setClassValue(this.scheme, 0, 'freqMax', e);
      await activate(this.scheme);
      this.lastAssertAt = Date.now();
    } catch (err) {
      console.error('[keeper] re-assert failed:', err);
    } finally {
      this.busy = false;
    }
  }
}

export const keeper = new CapKeeper();
