#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Pi Manager — 本地控制面

用法:
  pi-manager [选项]

选项:
  --host <地址>   监听地址（默认 127.0.0.1，或 PI_MANAGER_HOST）
  --port <端口>   监听端口（默认 8670，或 PI_MANAGER_PORT）
  --no-open       不打开浏览器
  -h, --help      显示帮助

缺 web/dist 时先运行: npm --prefix web run build
`;

export function parseCliArgs(argv) {
  const args = { host: undefined, port: undefined, open: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--no-open") {
      args.open = false;
      continue;
    }
    if (token === "--host") {
      args.host = requireValue(argv, ++i, "--host");
      continue;
    }
    if (token.startsWith("--host=")) {
      args.host = token.slice("--host=".length);
      continue;
    }
    if (token === "--port" || token === "-p") {
      args.port = parsePort(requireValue(argv, ++i, token));
      continue;
    }
    if (token.startsWith("--port=")) {
      args.port = parsePort(token.slice("--port=".length));
      continue;
    }
    throw new Error(`未知参数: ${token}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 需要一个值`);
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口: ${value}`);
  }
  return port;
}

export function hasWebUi(publicDir) {
  return fs.existsSync(path.join(publicDir, "index.html"));
}

export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url, { execFileImpl = execFile, platform = process.platform } = {}) {
  const { command, args } = browserCommand(url, platform);
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, (error) => error ? reject(error) : resolve());
  });
}

export function publicUrl(host, port) {
  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${hostname}:${port}`;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.host) process.env.PI_MANAGER_HOST = args.host;
  if (args.port) process.env.PI_MANAGER_PORT = String(args.port);

  const { startManagerServer, publicDir, store } = await import("./server.mjs");
  if (!hasWebUi(publicDir)) {
    console.error("缺少 web/dist/index.html。先运行: npm --prefix web run build");
    process.exitCode = 1;
    return 1;
  }

  const host = process.env.PI_MANAGER_HOST || "127.0.0.1";
  const port = Number(process.env.PI_MANAGER_PORT || 8670);
  const url = publicUrl(host, port);
  let started = false;
  try {
    await startManagerServer({ host, port });
    started = true;
    const gateway = store.get().gateway;
    console.log(`Pi Manager ${url}`);
    console.log(`Pi gateway: http://${gateway.host}:${gateway.port}/v1`);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.log(`Pi Manager 已在运行: ${url}`);
    } else {
      console.error(`Pi Manager 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return 1;
    }
  }

  if (args.open) {
    try {
      await openBrowser(url);
    } catch (error) {
      console.error(`无法打开浏览器: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`请手动打开 ${url}`);
    }
  }

  if (!started) return 0;
  await new Promise(() => {});
  return 0;
}

export function isCliEntrypoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return path.resolve(argv1) === fileURLToPath(moduleUrl);
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main, HELP };
