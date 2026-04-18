import { execSync, type ExecSyncOptions } from "node:child_process";

const COMPOSE_OPTS: ExecSyncOptions = {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
};

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function waitForEmulator(host: string, maxRetries = 30): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(`curl -sf http://${host}/v1/projects/test/instances`, {
        stdio: "pipe",
        timeout: 2000,
      });
      return;
    } catch {
      execSync("sleep 1", { stdio: "pipe" });
    }
  }
  throw new Error("Spanner emulator did not become ready in time");
}

export function setup() {
  if (!isDockerRunning()) {
    throw new Error(
      "Docker is not running. Start Docker and run tests again.\n" +
        "  E2E tests require the Spanner emulator: docker compose up -d"
    );
  }
  execSync("docker compose up -d --wait", COMPOSE_OPTS);
  waitForEmulator("localhost:9020");
}

export function teardown() {
  try {
    execSync("docker compose down", COMPOSE_OPTS);
  } catch {
    // Ignore errors during teardown (Docker may already be stopped)
  }
}
