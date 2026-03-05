#!/usr/bin/env node
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const PORTS_FILE = path.join(ROOT, ".oi-ports.json");

const app = process.argv[2];
if (!app) {
  console.error("Usage: node scripts/dev-with-port.mjs <backend|web|mobile|desktop|extension>");
  process.exit(1);
}

const APP_CONFIG = {
  backend: { key: "backend", defaultPort: 8080, envPortKeys: ["BACKEND_PORT", "PORT"] },
  web: { key: "web", defaultPort: 3000, envPortKeys: ["WEB_PORT", "PORT"] },
  mobile: { key: "mobile", defaultPort: 8081, envPortKeys: ["MOBILE_PORT", "PORT"] },
  desktop: { key: "desktop", defaultPort: null, envPortKeys: [] },
  extension: { key: "extension", defaultPort: null, envPortKeys: [] },
};

function readPorts() {
  try {
    return JSON.parse(fs.readFileSync(PORTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writePorts(next) {
  fs.writeFileSync(PORTS_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function envPreferredPort(keys, fallback) {
  for (const key of keys) {
    const raw = process.env[key];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 200; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`Could not find free port near ${start}`);
}

function run(cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
    cwd: ROOT,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function backendHttpUrl(backendPort) {
  return `http://127.0.0.1:${backendPort}`;
}

function backendWsUrl(backendPort) {
  return `ws://127.0.0.1:${backendPort}/ws`;
}

async function main() {
  const cfg = APP_CONFIG[app];
  if (!cfg) {
    throw new Error(`Unsupported app: ${app}`);
  }

  const ports = readPorts();
  let selectedPort = null;

  if (cfg.defaultPort != null) {
    const preferred = envPreferredPort(cfg.envPortKeys, cfg.defaultPort);
    selectedPort = await findFreePort(preferred);
    ports[cfg.key] = selectedPort;
    writePorts(ports);
    if (selectedPort !== preferred) {
      console.log(`[port-fallback] ${app}: ${preferred} busy, using ${selectedPort}`);
    } else {
      console.log(`[port] ${app}: ${selectedPort}`);
    }
  }

  const backendPort =
    Number.parseInt(process.env.BACKEND_PORT || "", 10)
    || Number.parseInt(process.env.PORT_BACKEND || "", 10)
    || ports.backend
    || 8080;
  const webPort =
    Number.parseInt(process.env.WEB_PORT || "", 10)
    || Number.parseInt(process.env.PORT_WEB || "", 10)
    || ports.web
    || 3000;

  if (app === "backend") {
    run("make", ["-C", "apps/backend", "dev", `PORT=${selectedPort}`], {
      BACKEND_PORT: String(selectedPort),
      PORT: String(selectedPort),
    });
    return;
  }

  if (app === "web") {
    run("pnpm", ["--filter", "@oi/web", "dev", "--", "--port", String(selectedPort)], {
      WEB_PORT: String(selectedPort),
      PORT: String(selectedPort),
      OI_BACKEND_PORT: String(backendPort),
    });
    return;
  }

  if (app === "mobile") {
    run("pnpm", ["--filter", "@oi/mobile", "start", "--", "--port", String(selectedPort)], {
      MOBILE_PORT: String(selectedPort),
      PORT: String(selectedPort),
      EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL || backendHttpUrl(backendPort),
    });
    return;
  }

  if (app === "desktop") {
    run("pnpm", ["--filter", "@oi/desktop", "dev"], {
      OI_WEB_URL: process.env.OI_WEB_URL || `http://127.0.0.1:${webPort}`,
    });
    return;
  }

  if (app === "extension") {
    run("pnpm", ["--filter", "@oi/extension", "dev"], {
      VITE_OI_RELAY_WS_URL: process.env.VITE_OI_RELAY_WS_URL || backendWsUrl(backendPort),
    });
    return;
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

