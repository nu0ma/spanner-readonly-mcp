import { type ExecSyncOptions, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Spanner } from "@google-cloud/spanner";

const COMPOSE_OPTS: ExecSyncOptions = {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
};

const SERVICE = "spanner-omni";
const READY_LOG = "Spanner is ready";
const EMULATOR_HOST = "127.0.0.1:15000";
const PROBE_PROJECT = "default";
const PROBE_INSTANCE = "default";

// Total budget kept at ~5 minutes (150 * 2s). The probe itself can take up to
// PROBE_TIMEOUT_MS so a slow tick still consumes one retry slot.
const MAX_RETRIES = 150;
const RETRY_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 8_000;

// Omni has been observed to print "Spanner is ready" and then segfault into a
// crashloop seconds later. A single successful gRPC call can also land during
// the brief window between restarts. Require a streak of clean probes so we
// only declare ready once the server has stayed up long enough for tests to
// finish their setup phase.
const REQUIRED_CONSECUTIVE_OK = 3;

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function logsContainReady(): boolean {
  try {
    const logs = execSync(`docker compose logs ${SERVICE}`, {
      ...COMPOSE_OPTS,
      encoding: "utf8",
    });
    return logs.includes(READY_LOG);
  } catch {
    // `docker compose logs` can fail briefly while the container is starting.
    return false;
  }
}

// Issues a real gRPC metadata RPC against the pre-provisioned `default`
// instance. This is what catches the case where logs say "ready" but the
// server is actually mid-segfault — exists() will hang or reject.
// Relies on SPANNER_EMULATOR_HOST being set (handled in setup() below) so
// the client uses an insecure channel against the local container.
async function probeGrpc(): Promise<void> {
  // Construct a fresh client per probe so a wedged connection from a prior
  // crash doesn't pollute subsequent attempts.
  const spanner = new Spanner({ projectId: PROBE_PROJECT });
  try {
    const instance = spanner.instance(PROBE_INSTANCE);
    // gax timeout alone isn't enough — a hung TCP connection mid-segfault
    // won't return an error, it will just stall. Race against a wall clock.
    const probe = instance.exists({ timeout: PROBE_TIMEOUT_MS });
    const wallClock = sleep(PROBE_TIMEOUT_MS).then(() => {
      throw new Error(`gRPC probe exceeded ${PROBE_TIMEOUT_MS}ms`);
    });
    const [exists] = (await Promise.race([probe, wallClock])) as [boolean];
    if (!exists) {
      throw new Error(`instance "${PROBE_INSTANCE}" not found`);
    }
  } finally {
    spanner.close();
  }
}

function captureDiagnostic(cmd: string): string {
  // Best-effort: any failure here must not mask the original timeout error.
  try {
    return execSync(cmd, {
      ...COMPOSE_OPTS,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `<failed to capture: ${message}>`;
  }
}

async function waitForSpannerOmni(): Promise<void> {
  let consecutiveOk = 0;
  let lastError: unknown;
  const startedAt = Date.now();

  for (let i = 0; i < MAX_RETRIES; i++) {
    if (logsContainReady()) {
      try {
        await probeGrpc();
        consecutiveOk += 1;
        if (consecutiveOk >= REQUIRED_CONSECUTIVE_OK) return;
      } catch (err) {
        // Reset the streak: a single failure means Omni may have crashed
        // since the last success.
        lastError = err;
        consecutiveOk = 0;
      }
    }
    await sleep(RETRY_INTERVAL_MS);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const detail =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? "no probe attempts succeeded");

  // Surface container state and recent logs in the thrown error so a CI or
  // local operator can diagnose image-pull failures, OOM, crash loops, etc.
  // without having to re-run `docker compose ps`/`logs` by hand.
  const psOutput = captureDiagnostic("docker compose ps");
  const logsOutput = captureDiagnostic(`docker compose logs --tail=50 ${SERVICE}`);

  throw new Error(
    `Spanner Omni did not stabilize within ${(MAX_RETRIES * RETRY_INTERVAL_MS) / 1000}s ` +
      `(needed ${REQUIRED_CONSECUTIVE_OK} consecutive successful gRPC probes). ` +
      `Elapsed: ${elapsedSec}s. Last probe error: ${detail}\n\n` +
      `--- docker compose ps ---\n${psOutput}\n\n` +
      `--- docker compose logs --tail=50 ${SERVICE} ---\n${logsOutput}`,
  );
}

export async function setup() {
  if (!isDockerRunning()) {
    throw new Error(
      "Docker is not running. Start Docker and run tests again.\n" +
        "  E2E tests require Spanner Omni: docker compose up -d",
    );
  }
  execSync("docker compose up -d", COMPOSE_OPTS);
  // The Spanner client honours SPANNER_EMULATOR_HOST to skip auth and use
  // an insecure channel. Set it for the probe so it matches the runtime
  // configuration the e2e tests use.
  process.env.SPANNER_EMULATOR_HOST = EMULATOR_HOST;
  await waitForSpannerOmni();
}

export function teardown() {
  try {
    // The `spanner` volume is intentionally preserved across runs so the next
    // `pnpm test` skips Spanner Omni's cold-start (tens of seconds to minutes).
    // For a full reset, run `docker compose down -v` manually.
    execSync("docker compose down", COMPOSE_OPTS);
  } catch {
    // Ignore errors during teardown (Docker may already be stopped)
  }
}
