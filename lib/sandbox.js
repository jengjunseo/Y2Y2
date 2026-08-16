import { createHash } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";

const NAME = "y2y2-media";
const PORT = 8080;
const BACKEND_VERSION = "0.2.0";
const REPO = "https://github.com/jengjunseo/Y2Y2.git";
const APP_DIR = "/vercel/sandbox/y2y2-app";
const SERVER = `${APP_DIR}/sandbox/backend.py`;
const TIMEOUT_MS = 45 * 60 * 1000;
let backendPromise;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tokens(sandbox) {
  return {
    control: digest(`y2y2:${sandbox.sandboxId}:control`),
    download: digest(`y2y2:${sandbox.sandboxId}:download`),
  };
}

async function cloneAndInstall(sandbox) {
  const clone = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", `rm -rf ${APP_DIR} && git clone --depth 1 ${REPO} ${APP_DIR}`],
  });
  if (clone.exitCode !== 0) throw new Error(clone.stderr || "Failed to clone Y2Y2 source");

  const install = await sandbox.runCommand({
    cmd: "python3",
    args: ["-m", "pip", "install", "--user", "--upgrade", "--pre", "yt-dlp", "imageio-ffmpeg"],
  });
  if (install.exitCode !== 0) throw new Error(install.stderr || "Failed to install media dependencies");
}

async function refreshSource(sandbox) {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `if [ -d ${APP_DIR}/.git ]; then git -C ${APP_DIR} fetch --depth 1 origin main && git -C ${APP_DIR} reset --hard origin/main; else git clone --depth 1 ${REPO} ${APP_DIR}; fi`,
    ],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Failed to refresh Y2Y2 source");
}

async function startBackend(sandbox) {
  const { control, download } = tokens(sandbox);
  await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "pkill -f '[s]andbox/backend.py' || true"],
  });
  await sandbox.runCommand({
    cmd: "python3",
    args: [SERVER],
    env: {
      PORT: String(PORT),
      Y2Y2_CONTROL_TOKEN: control,
      Y2Y2_DOWNLOAD_TOKEN: download,
      Y2Y2_DATA_DIR: "/vercel/sandbox/y2y2-data",
      Y2Y2_MAX_WORKERS: "2",
      PYTHONUNBUFFERED: "1",
    },
    detached: true,
  });
}

async function waitForHealth(sandbox, attempts = 40) {
  const baseUrl = sandbox.domain(PORT);
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
      if (response.ok) return { baseUrl, data: await response.json() };
      lastError = new Error(`Sandbox health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("Sandbox backend did not become ready");
}

async function boot() {
  const sandbox = await Sandbox.getOrCreate({
    name: NAME,
    runtime: "python3.13",
    resources: { vcpus: 2 },
    ports: [PORT],
    timeout: TIMEOUT_MS,
    persistent: true,
    snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
    onCreate: async (sbx) => {
      await cloneAndInstall(sbx);
      await startBackend(sbx);
    },
    onResume: async (sbx) => {
      await refreshSource(sbx);
      await startBackend(sbx);
    },
  });

  let health = await waitForHealth(sandbox);
  if (health.data?.version !== BACKEND_VERSION) {
    await refreshSource(sandbox);
    await startBackend(sandbox);
    health = await waitForHealth(sandbox);
  }
  if (health.data?.version !== BACKEND_VERSION) {
    throw new Error(`Sandbox backend version mismatch: ${health.data?.version || "unknown"}`);
  }

  const { control, download } = tokens(sandbox);
  return { sandbox, baseUrl: health.baseUrl, controlToken: control, downloadToken: download };
}

export async function getBackend() {
  if (!backendPromise) {
    backendPromise = boot().catch((error) => {
      backendPromise = undefined;
      throw error;
    });
  }
  return backendPromise;
}

export async function backendFetch(path, { method = "GET", body } = {}) {
  const backend = await getBackend();
  const response = await fetch(`${backend.baseUrl}${path}`, {
    method,
    headers: {
      "X-Y2Y2-Token": backend.controlToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  return { response, backend };
}

export async function readBackendJson(path, options) {
  const { response } = await backendFetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Sandbox request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
