/**



 * src/config.js
 * Validate environment variables and export a frozen config object.
 */

import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { hostname } from "os";
import { dirname, join, resolve } from "path";
import dotenv from "dotenv";

dotenv.config();
function requireEnv(name) {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    return { missing: true, name };
  }
  return { missing: false, value: val.trim() };
}

function optionalEnv(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  return val.trim();
}

function optionalFloat(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const numeric = Number.parseFloat(val.trim());
  if (Number.isNaN(numeric)) {
    process.stderr.write(`[config] WARNING: ${name}="${val}" is not a valid float, using default ${defaultValue}\n`);
    return defaultValue;
  }
  return numeric;
}

function optionalInt(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const numeric = Number.parseInt(val.trim(), 10);
  if (Number.isNaN(numeric)) {
    process.stderr.write(`[config] WARNING: ${name}="${val}" is not a valid integer, using default ${defaultValue}\n`);
    return defaultValue;
  }
  return numeric;
}

function optionalBool(name, defaultValue) {
  const val = process.env[name];
  if (!val || val.trim() === "") return defaultValue;
  const normalized = val.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  process.stderr.write(`[config] WARNING: ${name}="${val}" is not a valid boolean, using default ${defaultValue}\n`);
  return defaultValue;
}

function formatDeployVersion(value) {
  if (value && value.trim()) return value.trim();
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}: ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
}

function findWorkspaceRoot(startDir) {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, ".docker-volumes")) || existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function defaultSqlitePath() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (!workspaceRoot) return join(process.cwd(), ".docker-volumes", "s3proxy-data", "routes.db");
  return join(workspaceRoot, ".docker-volumes", "s3proxy-data", "routes.db");
}

const REQUIRED_VARS = ["PROXY_API_KEY", "FIREBASE_RTDB_URL", "FIREBASE_DB_SECRET"];
const missing = [];

for (const name of REQUIRED_VARS) {
  const result = requireEnv(name);
  if (result.missing) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  process.stderr.write(
      `[config] FATAL: Missing required environment variable(s):\n` +
      missing.map((value) => `  - ${value}`).join("\n") +
      `\n\nPlease set these variables before starting the server.\n` +
      `See root .env/.env.example for reference.\n`,
  );
  process.exit(1);
}

const instanceId = optionalEnv("INSTANCE_ID", null) || `${hostname()}-${process.pid}-${randomBytes(2).toString("hex")}`;

const config = Object.freeze({
  PROXY_API_KEY: process.env.PROXY_API_KEY.trim(),
  FIREBASE_RTDB_URL: process.env.FIREBASE_RTDB_URL.trim().replace(/\/$/, ""),
  FIREBASE_DB_SECRET: process.env.FIREBASE_DB_SECRET.trim(),
  PORT: optionalInt("PORT", 3000),
  QUOTA_THRESHOLD: optionalFloat("QUOTA_THRESHOLD", 0.9),
  QUOTA_POLL_INTERVAL_MS: optionalInt("QUOTA_POLL_INTERVAL_MS", 300_000),
  QUOTA_DRIFT_THRESHOLD_RATIO: optionalFloat("QUOTA_DRIFT_THRESHOLD_RATIO", 0.05),
  RECONCILE_INTERVAL_MS: optionalInt("RECONCILE_INTERVAL_MS", 900_000),
  INVENTORY_SCAN_PAGE_SIZE: optionalInt("INVENTORY_SCAN_PAGE_SIZE", 500),
  PENDING_SYNC_BATCH_SIZE: optionalInt("PENDING_SYNC_BATCH_SIZE", 200),
  RTDB_SYNC_BATCH_SIZE: optionalInt("RTDB_SYNC_BATCH_SIZE", 400),
  DRAIN_TIMEOUT_MS: optionalInt("DRAIN_TIMEOUT_MS", 30_000),
  LOG_LEVEL: optionalEnv("LOG_LEVEL", "info"),
  WEBHOOK_ALERT_URL: optionalEnv("WEBHOOK_ALERT_URL", ""),
  INSTANCE_ID: instanceId,
  SQLITE_PATH: optionalEnv("SQLITE_PATH", defaultSqlitePath()),
  LRU_MAX: optionalInt("LRU_MAX", 10_000),
  LRU_TTL_MS: optionalInt("LRU_TTL_MS", 300_000),
  ALLOW_INSECURE_SIGV4_KEY_EXTRACT: optionalBool("ALLOW_INSECURE_SIGV4_KEY_EXTRACT", false),
  DEPLOY_VERSION: formatDeployVersion(optionalEnv("DEPLOY_VERSION", "")),
  CRON_ENABLED: optionalBool("CRON_ENABLED", true),
  CRON_TIMEZONE: optionalEnv("CRON_TIMEZONE", "UTC"),
  CRON_RUN_ON_START: optionalBool("CRON_RUN_ON_START", true),
  CRON_KEEPALIVE_ENABLED: optionalBool("CRON_KEEPALIVE_ENABLED", true),
  CRON_KEEPALIVE_EXPRESSION: optionalEnv("CRON_KEEPALIVE_EXPRESSION", "0 */4 * * *"),
  CRON_KEEPALIVE_MODE: optionalEnv("CRON_KEEPALIVE_MODE", "scan"),
  CRON_KEEPALIVE_PREFIX: optionalEnv("CRON_KEEPALIVE_PREFIX", "_s3proxy_keepalive"),
  CRON_KEEPALIVE_CONTENT_PREFIX: optionalEnv("CRON_KEEPALIVE_CONTENT_PREFIX", "s3proxy-keepalive"),
  ADMIN_TEST_PREFIX: optionalEnv("ADMIN_TEST_PREFIX", "_s3proxy_probe"),
});

export default config;
