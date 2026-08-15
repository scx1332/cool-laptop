import type { Settings } from '../types.ts';

/**
 * Named starting points. Every value here is reachable through powercfg and
 * fully reversible; the UI lets you edit any field afterwards.
 *
 * boostMode: 0 = disabled, 1 = enabled, 2 = aggressive, 3 = efficient enabled,
 *            4 = efficient aggressive.
 * epp:       0 = maximum performance ... 100 = maximum efficiency.
 * coolingPolicy: 0 = passive (throttle before revving the fan), 1 = active.
 *
 * Frequency caps here stay at or below the measured base clocks (P ~1930 MHz,
 * E ~1750 MHz on the i7-12800H). Above base the cap is silently ignored, so a
 * "2800 MHz" limit would look like a setting and do nothing. Turbo is switched
 * off via boostMode instead, which is the only lever that works up there.
 */
export interface Profile {
  id: string;
  name: string;
  description: string;
  settings: Settings;
}

export const PROFILES: Profile[] = [
  {
    id: 'cool',
    name: 'Cool',
    description:
      'Turbo off and a hard 1200 MHz ceiling. Measured here: all-core load drops from about ' +
      '54 W to 18 W, with cores holding a steady 1178 MHz.',
    settings: {
      p: { freqMax: 1200, stateMax: 100, stateMin: 5, epp: 80, maxCores: 100 },
      e: { freqMax: 1100, stateMax: 100, stateMin: 5, epp: 80, maxCores: 100 },
      boostMode: 0,
      coolingPolicy: 0,
    },
  },
  {
    id: 'quiet',
    name: 'Quiet',
    description:
      'Caps at the base clock with turbo off — the chip runs at its rated frequency and no ' +
      'higher, which is where the power curve is still flat.',
    settings: {
      p: { freqMax: 1900, stateMax: 100, stateMin: 5, epp: 65, maxCores: 100 },
      e: { freqMax: 1700, stateMax: 100, stateMin: 5, epp: 70, maxCores: 100 },
      boostMode: 0,
      coolingPolicy: 0,
    },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Windows stock behaviour with no caps applied.',
    settings: {
      p: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      e: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
      boostMode: 2,
      coolingPolicy: 1,
    },
  },
  {
    id: 'max',
    name: 'Max',
    description:
      'Everything unrestricted, EPP pinned to performance, fan prioritised over throttling. ' +
      'The chip will still respect its own thermal and package limits.',
    settings: {
      p: { freqMax: 0, stateMax: 100, stateMin: 20, epp: 0, maxCores: 100 },
      e: { freqMax: 0, stateMax: 100, stateMin: 20, epp: 0, maxCores: 100 },
      boostMode: 2,
      coolingPolicy: 1,
    },
  },
  {
    id: 'p-only',
    name: 'P-cores only',
    description:
      'Holds the E-cores at their floor so the performance cores get the package budget to ' +
      'themselves. Pair it with an E-core benchmark selection to see the split.',
    settings: {
      p: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 30, maxCores: 100 },
      e: { freqMax: 800, stateMax: 100, stateMin: 5, epp: 100, maxCores: 20 },
      boostMode: 2,
      coolingPolicy: 1,
    },
  },
];

export function findProfile(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
