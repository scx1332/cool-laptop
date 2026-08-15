import type { AppState, RateState, RunRow, Settings } from './types.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () => req<AppState>('/api/state'),

  /** Switches the telemetry cadence between one a minute and one a second. */
  rate: (realtime: boolean) =>
    req<RateState>('/api/rate', { method: 'POST', body: JSON.stringify({ realtime }) }),

  applySettings: (s: Settings) =>
    req<Settings>('/api/settings', { method: 'POST', body: JSON.stringify(s) }),

  applyProfile: (id: string) => req<unknown>(`/api/profile/${id}`, { method: 'POST' }),

  restore: () => req<unknown>('/api/restore', { method: 'POST' }),

  calibrate: () => req<unknown>('/api/calibrate', { method: 'POST' }),

  governor: (body: {
    enabled: boolean;
    targetWatts?: number;
    floorMhz?: number;
    ceilingMhz?: number;
  }) => req<unknown>('/api/governor', { method: 'POST', body: JSON.stringify(body) }),

  bench: (body: {
    kind: '7zip' | 'loadgen';
    cpus: number[];
    threads?: number;
    durationSec?: number;
    dictLog2?: number;
  }) => req<unknown>('/api/bench', { method: 'POST', body: JSON.stringify(body) }),

  cancelBench: () => req<unknown>('/api/bench/cancel', { method: 'POST' }),

  runs: () => req<RunRow[]>('/api/runs?limit=40'),

  deleteRun: (id: number) => req<unknown>(`/api/runs/${id}`, { method: 'DELETE' }),
};
