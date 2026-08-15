import { setFreqCaps } from './powercfg.ts';
import { keeper } from './keeper.ts';
import { getCalibration, telemetry } from '../telemetry/poller.ts';
import type { GovernorState, Sample } from '../types.ts';

/**
 * Closed-loop package power limiter.
 *
 * We cannot write PL1/PL2 directly — those are MSRs and need ring 0. But we
 * can read package power from RAPL every second and we can change the
 * frequency cap, so we can servo the cap until measured power sits at the
 * target. The result behaves like a configurable wattage limit without any
 * kernel driver.
 *
 * Control law is a damped proportional step with a deadband. Deliberately not
 * a full PID: each correction costs several powercfg round-trips, so the cost
 * of overshooting and oscillating is far higher than converging a little
 * slower.
 *
 * IMPORTANT range limitation, measured on this hardware: a frequency cap is
 * only honoured up to roughly the core's base clock. Below base it is exact
 * and repeatable (a 1200 MHz cap measures 1178 MHz); above base every step is
 * a turbo bin the OS cannot select, so the cap is simply ignored. The
 * "maximum processor state" percentage is worse — it reads back correctly but
 * the platform overrides it, giving 1551 / 3412 / 2563 MHz for the same
 * requested 50%.
 *
 * So the governor servos with the frequency cap and treats anything at or
 * above base as "unrestricted". That makes it effective for holding a package
 * budget below the natural all-core draw, which is the point, but it cannot
 * finely trim power in the turbo range. Use boost mode for that.
 */

/** Roughly how many MHz of cap equal one watt of package power on a mobile
 *  H-series part. Measured here: ~50 W at 3.3 GHz all-core vs ~22 W at 1.4 GHz,
 *  which is ~68 MHz/W. We use less than that for damping. */
const MHZ_PER_WATT = 40;

/** Do not bother re-applying a cap for changes smaller than this. */
const DEADBAND_MHZ = 75;

/** Package power within this many watts of target counts as converged. */
const TOLERANCE_W = 1.5;

/** Apply at most one correction per this many samples. */
const DECIMATION = 2;

export class Governor {
  state: GovernorState = {
    enabled: false,
    targetWatts: 25,
    floorMhz: 800,
    ceilingMhz: 0,
    currentCapMhz: 0,
  };

  private scheme: string | null = null;
  private tick = 0;
  private busy = false;
  private unsubscribe: (() => void) | null = null;
  private smoothedW = 0;
  onChange: ((s: GovernorState) => void) | null = null;

  attach(schemeGuid: string): void {
    this.scheme = schemeGuid;
    this.unsubscribe ??= telemetry.subscribe((s) => void this.onSample(s));
  }

  async enable(targetWatts: number, floorMhz?: number, ceilingMhz?: number): Promise<void> {
    this.state.targetWatts = targetWatts;
    if (floorMhz !== undefined) this.state.floorMhz = floorMhz;
    if (ceilingMhz !== undefined) this.state.ceilingMhz = ceilingMhz;
    this.state.enabled = true;

    // Start from the ceiling so the first correction walks down into the
    // target rather than jumping the machine to a crawl. Default the ceiling
    // to the calibrated base clock: above it the cap does nothing, so
    // starting higher just wastes correction cycles doing nothing visible.
    const start = this.state.ceilingMhz || this.defaultCeiling();
    this.state.currentCapMhz = start;
    this.smoothedW = telemetry.latest?.power.pkg ?? targetWatts;
    await this.applyCap(start);
    this.onChange?.(this.state);
  }

  async disable(): Promise<void> {
    this.state.enabled = false;
    this.state.currentCapMhz = 0;
    keeper.setGovernorCap(null);
    if (this.scheme) await setFreqCaps(this.scheme, 0, 0);
    this.onChange?.(this.state);
  }

  /** The highest cap that still has any effect on this silicon. */
  private defaultCeiling(): number {
    return getCalibration().pBaseMhz;
  }

  private async applyCap(mhz: number): Promise<void> {
    if (!this.scheme) return;
    // The E-cores top out well below the P-cores, so the same numeric cap is
    // simply a no-op for them once it exceeds their maximum. Passing it to
    // both keeps the two classes tracking each other under a shared budget.
    await setFreqCaps(this.scheme, mhz, mhz);
    this.state.currentCapMhz = mhz;
    // Hand the cap to the keeper so the platform's power service cannot quietly
    // zero it between corrections.
    keeper.setGovernorCap(mhz);
  }

  private async onSample(s: Sample): Promise<void> {
    if (!this.state.enabled || this.busy) return;
    if (++this.tick % DECIMATION !== 0) return;

    // Light smoothing: RAPL is noisy sample to sample and we do not want to
    // chase a transient.
    this.smoothedW = this.smoothedW * 0.5 + s.power.pkg * 0.5;

    const error = this.state.targetWatts - this.smoothedW;
    if (Math.abs(error) <= TOLERANCE_W) return;

    const ceiling = this.state.ceilingMhz || this.defaultCeiling();
    const proposed = clamp(
      this.state.currentCapMhz + error * MHZ_PER_WATT,
      this.state.floorMhz,
      ceiling,
    );
    const rounded = Math.round(proposed / 25) * 25;

    if (Math.abs(rounded - this.state.currentCapMhz) < DEADBAND_MHZ) return;

    this.busy = true;
    try {
      await this.applyCap(rounded);
      this.onChange?.(this.state);
    } catch (e) {
      console.error('[governor] failed to apply cap:', e);
    } finally {
      this.busy = false;
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export const governor = new Governor();
