import type { Settings } from '../types.ts';

/**
 * Three states, ordered coolest to hottest. Everything here is reachable
 * through powercfg and fully reversible; the UI lets you edit any field
 * afterwards.
 *
 * boostMode: 0 = disabled, 1 = enabled, 2 = aggressive, 3 = efficient enabled,
 *            4 = efficient aggressive.
 * epp:       0 = maximum performance ... 100 = maximum efficiency.
 *
 * Why only three. Turbo boost and the frequency cap act on the same axis and
 * divide it cleanly: the cap is exact and continuous below the base clock and
 * silently ignored above it, while turbo off is the single available stop at
 * base. So the whole usable range is "cap somewhere under base", "turbo off",
 * or "unrestricted" — and intermediate profiles were mostly re-describing the
 * same two positions. Measured all-core, two passes:
 *
 *   turbo on,  no cap       27.6 / 26.5 W   2011 / 1927 MHz
 *   turbo off, no cap       13.0 / 13.1 W   1538 / 1518 MHz
 *   turbo on,  cap 1200     10.9 / 10.7 W   1127 / 1121 MHz
 *   turbo off, cap 1200     11.3 / 10.3 W   1122 / 1123 MHz
 *
 * Note the bottom two rows: once a cap is in force below base, turbo state
 * stops mattering. The levers are redundant, not additive.
 *
 * stateMax, stateMin and maxCores are pinned by normalise() in powercfg.ts and
 * are listed here only because the type requires them — changing them has no
 * effect.
 */
export interface Profile {
  id: string;
  name: string;
  description: string;
  settings: Settings;
}

/** The lowest frequency the cap will accept, matching the UI slider's floor. */
const MIN_MHZ = 400;

export const PROFILES: Profile[] = [
  {
    id: 'min',
    name: 'Min',
    description:
      'Both core classes pinned to the 400 MHz floor with energy preference all the way to ' +
      'efficiency. Deliberately close to unusable for anything active — the point is reading ' +
      'or watching something on battery, not working.',
    settings: {
      p: { freqMax: MIN_MHZ, stateMax: 100, stateMin: 5, epp: 100, maxCores: 100 },
      e: { freqMax: MIN_MHZ, stateMax: 100, stateMin: 5, epp: 100, maxCores: 100 },
      boostMode: 0,
    },
  },
  {
    id: 'cool',
    name: 'Cool',
    description:
      'Turbo off, nothing else touched — the chip runs up to its base clock and no higher. ' +
      'Measured here: all-core load falls from about 27 W to 13 W. Everyday setting.',
    settings: {
      // No frequency cap on purpose. Below base a cap would cost real speed for
      // no thermal benefit that turbo-off has not already banked, and above
      // base it does nothing at all. Turbo off is the whole profile.
      p: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      e: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      boostMode: 0,
    },
  },
  {
    id: 'default',
    name: 'Default',
    description:
      'Stock Windows behaviour: no caps, turbo unrestricted. Fast, hot, and loud under load.',
    settings: {
      p: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      e: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      boostMode: 2,
    },
  },
];

export function findProfile(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
