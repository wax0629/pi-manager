import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KEYCHAIN_SERVICE = "pi-manager";

function canUseKeychain() {
  return process.platform === "darwin" && process.env.PI_MANAGER_DISABLE_KEYCHAIN !== "1";
}

function fallbackPath(dataDir) {
  return path.join(dataDir, "credentials.json");
}

function readFallback(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(fallbackPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function writeFallback(dataDir, values) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = fallbackPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export function readDotEnvValue(filePath, key) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*(.*)\\s*$`));
      if (!match) continue;
      const value = match[1].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
      }
      return value;
    }
  } catch {
    // Missing bridge or env file is a normal unconfigured state.
  }
  return "";
}

export function getSecret({ dataDir, provider }) {
  const envValue = provider.credentialEnv ? process.env[provider.credentialEnv] : "";
  if (envValue) return envValue;

  if (provider.id === "antigravity" && provider.bridgePath) {
    const bridgeValue = readDotEnvValue(path.join(provider.bridgePath, ".env"), provider.credentialEnv || "API_KEY");
    if (bridgeValue) return bridgeValue;
  }

  if (canUseKeychain()) {
    try {
      return execFileSync("security", ["find-generic-password", "-a", provider.id, "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      // Fall through to the local permission-hardened file.
    }
  }

  return readFallback(dataDir)[provider.id] || "";
}

export function setSecret({ dataDir, providerId, value }) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error("凭据不能为空");

  if (canUseKeychain()) {
    try {
      execFileSync("security", ["add-generic-password", "-a", providerId, "-s", KEYCHAIN_SERVICE, "-w", normalized, "-U"], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      return { storage: "keychain" };
    } catch {
      // Use the permission-hardened fallback if Keychain is unavailable.
    }
  }

  const values = readFallback(dataDir);
  values[providerId] = normalized;
  writeFallback(dataDir, values);
  return { storage: "local-file" };
}

export function deleteSecret({ dataDir, providerId }) {
  if (canUseKeychain()) {
    try {
      execFileSync("security", ["delete-generic-password", "-a", providerId, "-s", KEYCHAIN_SERVICE], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      // It is fine when the item does not exist.
    }
  }

  const values = readFallback(dataDir);
  if (Object.hasOwn(values, providerId)) {
    delete values[providerId];
    writeFallback(dataDir, values);
  }
}

export function hasSecret(options) {
  return Boolean(getSecret(options));
}
