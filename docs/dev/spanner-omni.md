# Spanner Omni for local E2E

## What it is

Spanner Omni is the production Spanner binary repackaged for self-hosting. We run it via `start-single-server` as the E2E backend in `docker-compose.yml`. Unlike the legacy `gcr.io/cloud-spanner-emulator/emulator`, Omni reuses the production query/transaction stack, so production-only semantics (most notably **DML rejection inside read-only snapshot transactions** — the authoritative half of this server's read-only guarantee) are exercised by tests.

## Conventions

- gRPC endpoint: `127.0.0.1:15000`
- Pre-provisioned `project = default`, `instance = default`. Tests only have to manage their own database.
- Connect via `SPANNER_EMULATOR_HOST=127.0.0.1:15000`. The Spanner SDK treats this env var as a "use insecure channel and skip auth" trigger; Omni isn't really an emulator but it speaks the same protocol on a local socket, so the same switch works.

## Lifecycle

- **Automatic** — `pnpm test`'s vitest `globalSetup` runs `docker compose up -d`, waits for the readiness signal, then runs `docker compose down` after the suite (volume preserved; use `pnpm omni:reset` for a clean slate). Docker must already be running.
- **Manual** — for `pnpm test:watch` or repeated reruns it's faster to keep the container up:
  - `pnpm omni:up` — start in the background
  - `pnpm omni:down` — stop, **keep** the volume (fast restart next time)
  - `pnpm omni:reset` — stop and **delete** the volume (full clean slate)
  - `pnpm omni:logs` — follow container logs

## Readiness probe

`test/global-setup.ts` does not trust the log line alone. Omni occasionally prints `Spanner is ready` and then segfaults seconds later, and a single gRPC probe can land in the gap between restarts. The probe therefore requires **3 consecutive successful `instance.exists()` RPCs** against `default/default` before declaring the server ready, with a wall-clock race around each call so a hung connection mid-segfault doesn't stall forever. On timeout the error message includes elapsed seconds, `docker compose ps`, and the last 50 log lines so failures are debuggable without re-running.

## Troubleshooting

### Apple Silicon (arm64): segfault crashloop

Symptom: `Spanner is ready` followed by repeated `signal: segmentation fault` lines from `zone_services`, `base_services`, or `server`. The readiness probe never gets its 3-streak and times out.

Mitigation (already applied): `docker-compose.yml` caps the container at `cpus: 2.0`. Empirically this eliminates the startup crash storm on Apple Silicon / OrbStack — controlled tests showed 30+ supervisor restarts in 90 s on default resources versus zero with `cpus: 2.0`. No additional action is required for normal use; if you still hit a crash, `pnpm omni:reset && pnpm omni:up` for a clean volume usually unsticks it. The root cause appears to be a mixed-signal (SIGSEGV/SIGBUS/SIGILL) instability in the upstream `2026.r1-beta` arm64 binary when scheduled across many vCPUs; `linux/amd64` via Rosetta is not viable because the launcher requires AMD64 v3 (AVX2/BMI2) which Rosetta does not emulate.

### CI (Linux x86_64): stable

GitHub Actions `ubuntu-latest` has not reproduced the crashloop. When the Test step fails, the workflow uploads a `spanner-omni-debug-{run_id}-{run_attempt}` artifact containing `docker compose logs`, `docker compose ps`, volume/image state, and vitest stdout (7-day retention) — start there for post-mortems.

### Cold start is slow

First boot pulls the image and initializes a fresh volume; expect tens of seconds to a few minutes. `pnpm omni:reset` (or `pnpm test`'s teardown, which uses `-v`) puts you back in cold-start territory. For tight iteration, use `pnpm omni:down` to preserve the volume.

### `MetadataLookupWarning` in logs

The `gcp-metadata` library probes the GCE metadata server on startup; `SPANNER_EMULATOR_HOST` does not silence it. `test/e2e.test.ts` sets `METADATA_SERVER_DETECTION=none` to suppress the probe. Harmless either way.

## Reference

- [Spanner Omni docs](https://cloud.google.com/spanner-omni/docs)
- Related files: `docker-compose.yml`, `test/global-setup.ts`, `test/e2e.test.ts`, `.github/workflows/ci.yaml`
