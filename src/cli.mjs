#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_MESSAGES = {
  zh: {
    help: `Pi Manager — 本地控制面

用法:
  pi-manager [选项]

选项:
  --host <地址>   监听地址（默认 127.0.0.1，或 PI_MANAGER_HOST）
  --port <端口>   监听端口（默认 8670，或 PI_MANAGER_PORT）
  --no-open       不打开浏览器
  -h, --help      显示帮助

缺 web/dist 时先运行: npm --prefix web run build
`,
    unknownArg: "未知参数: {token}",
    needValue: "{flag} 需要一个值",
    invalidPort: "无效端口: {value}",
    missingDist: "缺少 web/dist/index.html。先运行: npm --prefix web run build",
    alreadyRunning: "Pi Manager 已在运行: {url}",
    startFailed: "Pi Manager 启动失败: {error}",
    cannotOpen: "无法打开浏览器: {error}",
    openManual: "请手动打开 {url}"
  },
  en: {
    help: `Pi Manager — local control plane

Usage:
  pi-manager [options]

Options:
  --host <address>  listen address (default 127.0.0.1, or PI_MANAGER_HOST)
  --port <port>     listen port (default 8670, or PI_MANAGER_PORT)
  --no-open         do not open a browser
  -h, --help        show help

If web/dist is missing, run: npm --prefix web run build
`,
    unknownArg: "Unknown argument: {token}",
    needValue: "{flag} requires a value",
    invalidPort: "Invalid port: {value}",
    missingDist: "Missing web/dist/index.html. Run: npm --prefix web run build",
    alreadyRunning: "Pi Manager is already running at {url}",
    startFailed: "Pi Manager failed to start: {error}",
    cannotOpen: "Could not open the browser: {error}",
    openManual: "Open {url} manually"
  }
};

export function cliLocale(env = process.env) {
  const explicit = String(env.PI_MANAGER_LANG || "").trim().toLowerCase();
  if (explicit === "zh" || explicit.startsWith("zh")) return "zh";
  if (explicit === "en" || explicit.startsWith("en")) return "en";
  const lang = String(env.LANG || env.LC_ALL || env.LC_MESSAGES || "").toLowerCase();
  return lang.startsWith("zh") ? "zh" : "en";
}

function formatCliMessage(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

export function cliMessage(key, params, env = process.env) {
  const locale = cliLocale(env);
  const table = CLI_MESSAGES[locale] || CLI_MESSAGES.en;
  return formatCliMessage(table[key] || CLI_MESSAGES.en[key] || key, params);
}

const HELP = CLI_MESSAGES.en.help;

export function parseCliArgs(argv, env = process.env) {
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
      args.host = requireValue(argv, ++i, "--host", env);
      continue;
    }
    if (token.startsWith("--host=")) {
      args.host = token.slice("--host=".length);
      continue;
    }
    if (token === "--port" || token === "-p") {
      args.port = parsePort(requireValue(argv, ++i, token, env), env);
      continue;
    }
    if (token.startsWith("--port=")) {
      args.port = parsePort(token.slice("--port=".length), env);
      continue;
    }
    throw new Error(cliMessage("unknownArg", { token }, env));
  }
  return args;
}

function requireValue(argv, index, flag, env = process.env) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(cliMessage("needValue", { flag }, env));
  return value;
}

function parsePort(value, env = process.env) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(cliMessage("invalidPort", { value }, env));
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
    process.stdout.write(cliMessage("help"));
    return 0;
  }
  if (args.host) process.env.PI_MANAGER_HOST = args.host;
  if (args.port) process.env.PI_MANAGER_PORT = String(args.port);

  const { startManagerServer, publicDir, store } = await import("./server.mjs");
  if (!hasWebUi(publicDir)) {
    console.error(cliMessage("missingDist"));
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
      console.log(cliMessage("alreadyRunning", { url }));
    } else {
      console.error(cliMessage("startFailed", { error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
      return 1;
    }
  }

  if (args.open) {
    try {
      await openBrowser(url);
    } catch (error) {
      console.error(cliMessage("cannotOpen", { error: error instanceof Error ? error.message : String(error) }));
      console.error(cliMessage("openManual", { url }));
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

export { main, HELP, CLI_MESSAGES };
