import { readFile } from "node:fs/promises";
import type {
  CoolifyDeploymentSummary,
  CoolifyResourceSummary,
  CoolifySnapshot,
} from "../types.js";

const DEFAULT_STATE_PATH = "/var/lib/coolify-monitor/state.json";
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SAFE_STATUS = /^[a-z0-9_.: -]{1,80}$/i;

function isString(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nullableString(value: unknown, max = 500): value is string | null {
  return value === null || isString(value, max);
}

function validTimestamp(value: unknown): value is string {
  return isString(value, 64) && Number.isFinite(Date.parse(value));
}

function validDeployment(
  value: unknown,
): value is CoolifyDeploymentSummary | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isString(item.uuid, 100) &&
    isString(item.status, 80) &&
    SAFE_STATUS.test(item.status) &&
    (item.startedAt === null || validTimestamp(item.startedAt)) &&
    (item.finishedAt === null || validTimestamp(item.finishedAt))
  );
}

function validResource(value: unknown): value is CoolifyResourceSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isString(item.uuid, 100) &&
    isString(item.name, 300) &&
    isString(item.type, 80) &&
    isString(item.status, 80) &&
    SAFE_STATUS.test(item.status) &&
    isString(item.project, 300) &&
    isString(item.environment, 300) &&
    nullableString(item.image, 500) &&
    nullableString(item.imageTag, 300) &&
    nullableString(item.repository, 500) &&
    typeof item.registered === "boolean" &&
    isString(item.dashboardUrl, 1000) &&
    item.dashboardUrl.startsWith("https://app.coolify.io/") &&
    validDeployment(item.activeDeployment) &&
    validDeployment(item.latestDeployment)
  );
}

export function validateCoolifySnapshot(value: unknown): CoolifySnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Coolify state is not an object");
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    state.source !== "https://app.coolify.io" ||
    !validTimestamp(state.generatedAt) ||
    !validTimestamp(state.lastAttemptAt) ||
    typeof state.staleAfterSeconds !== "number" ||
    !Number.isInteger(state.staleAfterSeconds) ||
    state.staleAfterSeconds < 30 ||
    state.staleAfterSeconds > 86_400 ||
    !(state.error === null || isString(state.error, 500)) ||
    !Array.isArray(state.resources) ||
    !state.resources.every(validResource)
  ) {
    throw new Error("Coolify state failed schema validation");
  }
  return state as unknown as CoolifySnapshot;
}

export async function readCoolifySnapshot(
  path = process.env.COOLIFY_STATE_PATH ?? DEFAULT_STATE_PATH,
): Promise<CoolifySnapshot> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES) {
    throw new Error("Coolify state is too large");
  }
  return validateCoolifySnapshot(JSON.parse(raw));
}
