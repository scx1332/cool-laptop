# PowerManagement

A local web app for shaping CPU power and frequency behaviour on a Dell Latitude 5531
(Intel i7-12800H), and measuring what each change actually costs or buys.

Bun serves the API and a WebSocket telemetry stream; a Vite/React frontend renders it.
Everything runs in userspace — no kernel driver, no MSR access.

## Running it

```bash
bun install
bun run build        # build the frontend once
bun run server       # http://localhost:4317
```

For frontend development, run the API and Vite side by side:

```bash
bun run server       # terminal 1
bun run web          # terminal 2 -> http://localhost:5173, proxies to the API
```

Run it from an **elevated** shell. `powercfg` writes to the active scheme need
administrator rights.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PM_PORT` | `4317` | HTTP/WebSocket port |
| `PM_INTERVAL_MS` | `1000` | Telemetry cadence. 1 s is a test-phase value; raise it in production — the RAPL reads are cheap but the SQLite writes are not |
| `PM_DB` | file | Set to `memory` for an in-RAM database and no disk traffic |
| `PM_RETENTION_HOURS` | `24` | Sample retention before pruning |
| `PM_WATCHDOG_MS` | `300000` | If all browser tabs close while limits are applied, revert to stock after this long |

## What it does

- **Live telemetry at 1 Hz** — package / core / iGPU power from Intel RAPL, per-core
  clock and utilisation, core parking, and the kernel's throttle-reason flags.
- **Per-class control** — independent frequency cap, processor state, energy-performance
  preference, and core parking for P-cores and E-cores.
- **Wattage governor** — a closed loop that servos the frequency cap until measured
  package power sits at a target.
- **Benchmarks with core affinity** — 7-Zip for a scored result (MIPS) and a built-in
  load generator for sustained load, both pinned to any subset of the 20 logical CPUs.
- **Results history** — every run stored with its score, average and peak watts, average
  clock, the settings in force, and a score-per-watt efficiency figure.

Settings are applied to a dedicated duplicated power scheme named
`PowerManagement Lab`. Your own Balanced plan is never modified, and the original
scheme is reactivated on exit.

## What was measured on this machine

Findings from validating against the actual hardware. Several are non-obvious and drove
the design.

### Topology

CPU 0–11 are the six hyperthreaded P-cores (efficiency class 1); CPU 12–19 are the eight
E-cores (class 0). Read from `GetSystemCpuSetInformation`, a documented userspace Win32
call, rather than inferred from core numbering.

### Clock readings need calibration

`% Processor Performance` is a percentage of each core's nominal base clock, and that
base differs between P and E cores. Windows exposes the value nowhere usable:
`Win32_Processor`, the registry, and the `Processor Frequency` counter all report a flat
1800/1805 MHz for every core.

So the app measures it — clamp a class to a known frequency, saturate it, read the
percentage back. Measured bases: **P ≈ 1928 MHz, E ≈ 1750 MHz**. Without this, E-cores
report impossible clocks above 4 GHz.

### Frequency caps only bind at or below base

| Requested cap | Measured |
|---|---|
| 1200 MHz | 1178 MHz |
| 1500 MHz | 1500 MHz |
| 2000 MHz | 2034 MHz |
| 2800 MHz | 3515 MHz — ignored |
| 3600 MHz | 3614 MHz — ignored |

Below base the cap is exact and repeatable. Above base every step is a turbo bin the OS
cannot select, so the setting is accepted, reads back correctly, and does nothing. Turbo
on/off (boost mode) is the only lever that works up there.

### Maximum processor state is only a hint

`PROCTHROTTLEMAX` reads back correctly but the platform overrides it. The same requested
50% produced 1551, 3412, and 2563 MHz on three consecutive runs. The app does not rely on
it for control.

### The platform wipes frequency caps — hence the keeper

This was the big one. Polling the stored cap after applying it:

```
t+ 5s  P=0x4b0 E=0x4b0     (1200 MHz, as requested)
t+10s  P=0x000 E=0x000     (zeroed, by nothing we did)
t+15s  P=0x000 E=0x000     ... and it stays zeroed
```

Something — Intel's Innovation Platform Framework / Dynamic Tuning services (`ipfsvc`,
`dptftcs`), which own power policy on Dell hardware — resets the cap to zero within about
ten seconds. This is what made early measurements look random: a cap applied and measured
a few seconds later sometimes held and sometimes had already evaporated.

The fix is `server/control/keeper.ts`, which re-asserts the caps every 1.5 s. With it, an
all-core load holds a 1200 MHz cap indefinitely:

```
t+ 5s  P 1178 MHz  E 1125 MHz  18.1 W
t+25s  P 1178 MHz  E 1125 MHz  17.9 W
t+55s  P 1177 MHz  E 1125 MHz  18.0 W
```

Against roughly 54 W and 3.3 GHz uncapped. Calibration re-asserts its own cap for the same
reason — a single write before a nine-second measurement is a coin flip.

### Affinity must target the real binary

`bun` on PATH is a `.cmd` shim that launches `bun.exe` as a child. Setting processor
affinity on the shim does not reach that child, so pinned load silently escapes onto every
core — E-core runs showed 4% E utilisation and 135% P utilisation. The runner uses
`process.execPath`.

### Power limits observed

Idle sits near 6 W. An all-core load spikes to about 67 W (PL2) then settles at 50–55 W
with clocks around 3.3 GHz.

### Why there are no temperatures

Core temperature lives in the `IA32_THERM_STATUS` MSR, readable only with the ring-0
`RDMSR` instruction — administrator rights do not help, since admin is still ring 3. Tools
like Core Temp and HWiNFO ship a signed kernel driver whose entire job is to run that one
instruction. This machine's ACPI thermal zones are empty (`MSAcpi_ThermalZoneTemperature`
returns "Not supported"), because Dell handles thermal management in the embedded
controller and DPTF firmware without involving the OS.

Power is arguably the better control signal anyway: it responds immediately, whereas
temperature lags several seconds behind due to thermal mass. Watts are the cause, degrees
are the symptom.

## Measurement caveat

Benchmark results are only comparable on a quiet machine. Every run records the CPU
utilisation in the seconds before it started, and the results table flags runs that began
above 15%. During development, background Chrome and Windows Defender activity alone were
enough to invert conclusions.

## Layout

```
server/
  index.ts               HTTP + WebSocket API, watchdog, shutdown restore
  config.ts              environment configuration
  db.ts                  bun:sqlite storage and migrations
  topology.ts            P/E core map via GetSystemCpuSetInformation
  telemetry/
    sidecar.ps1          persistent 1 Hz JSON telemetry process
    topology.ps1         CPU-set enumeration
    poller.ts            sidecar lifecycle, parsing, MHz derivation
    calibrate.ts         per-class base-clock measurement
  control/
    powercfg.ts          typed powercfg wrapper, lab scheme management
    keeper.ts            re-asserts caps against the platform's resets
    governor.ts          closed-loop wattage limiter
    profiles.ts          Cool / Quiet / Balanced / Max / P-cores only
  bench/
    runner.ts            run orchestration and telemetry attribution
    loadgen.ts           affinity-pinned load generator
    worker.ts            load thread
    affinity.ts          processor affinity assignment
web/src/                 React frontend
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Everything the UI needs in one payload |
| GET/POST | `/api/settings` | Read or apply per-class settings |
| POST | `/api/profile/:id` | Apply a named profile |
| POST | `/api/restore` | Return to stock |
| POST | `/api/calibrate` | Re-measure base clocks (~25 s, loads the CPU) |
| POST | `/api/governor` | Enable/disable the wattage governor |
| POST | `/api/bench` | Start a benchmark; progress streams over the WebSocket |
| POST | `/api/bench/cancel` | Cancel the running benchmark |
| GET | `/api/runs` | Result history |
| GET | `/api/samples?minutes=N` | Stored telemetry |

The WebSocket at `/ws` pushes `state`, `sample`, `settings`, `governor`, `calibration`,
`bench`, and `status` messages.

## Safety

- Changes are confined to the `PowerManagement Lab` scheme; the original scheme is
  restored on exit.
- `SIGINT`/`SIGTERM` revert to stock settings before exiting.
- A watchdog reverts to stock if every browser tab closes while limits are applied, so a
  forgotten 1 GHz cap cannot survive the session.
