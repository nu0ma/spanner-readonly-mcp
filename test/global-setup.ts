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

async function waitForSpannerOmni(): Promise<void> {
  let consecutiveOk = 0;
  let lastError: unknown;

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

  const detail =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? "no probe attempts succeeded");
  throw new Error(
    `Spanner Omni did not stabilize within ${(MAX_RETRIES * RETRY_INTERVAL_MS) / 1000}s ` +
      `(needed ${REQUIRED_CONSECUTIVE_OK} consecutive successful gRPC probes). Last probe error: ${detail}`,
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
    execSync("docker compose down -v", COMPOSE_OPTS);
  } catch {
    // Ignore errors during teardown (Docker may already be stopped)
  }
}
