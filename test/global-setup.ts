import { type ExecSyncOptions, execSync } from "node:child_process";

const COMPOSE_OPTS: ExecSyncOptions = {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
};

const SERVICE = "spanner-omni";
const READY_LOG = "Spanner is ready";

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Spanner Omni's single-server image has no health endpoint and no
// docker-compose healthcheck, so we poll its logs for the readiness banner.
function waitForSpannerOmni(maxRetries = 90, intervalMs = 2000): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const logs = execSync(`docker compose logs ${SERVICE}`, {
        ...COMPOSE_OPTS,
        encoding: "utf8",
      });
      if (logs.includes(READY_LOG)) return;
    } catch {
      // logs subcommand can fail briefly while the container is starting;
      // fall through to the sleep and retry.
    }
    execSync(`sleep ${intervalMs / 1000}`, { stdio: "pipe" });
  }
  throw new Error("Spanner Omni did not become ready in time");
}

export function setup() {
  if (!isDockerRunning()) {
    throw new Error(
      "Docker is not running. Start Docker and run tests again.\n" +
        "  E2E tests require Spanner Omni: docker compose up -d",
    );
  }
  execSync("docker compose up -d", COMPOSE_OPTS);
  waitForSpannerOmni();
}

export function teardown() {
  try {
    execSync("docker compose down -v", COMPOSE_OPTS);
  } catch {
    // Ignore errors during teardown (Docker may already be stopped)
  }
}
