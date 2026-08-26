import type { WorkflowRun } from "../types.js";

export const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
]);
export const MIN_REFRESH_INTERVAL_MS = 15_000;
export const ACTIVE_REFRESH_INTERVAL_MS = 30_000;
export const DISCOVERY_REFRESH_INTERVAL_MS = 60_000;
export const MAX_DURATION_SAMPLES = 5;

export interface AdaptiveRefreshResult {
  delayMs: number;
  /** Repos currently known to have active runs. */
  activeRepos: string[];
  /** True when the next poll must inspect every configured repository. */
  refreshAllRepos: boolean;
}

/**
 * Plan the lightweight Actions-run poll independently from the hourly full
 * metadata refresh. Every configured repository is inspected at least once a
 * minute so newly started runs can be discovered. Repositories already known
 * to be active are checked every 30 seconds. Historical run duration is not a
 * freshness signal: a long-running workflow must not make the dashboard sleep
 * until its predicted completion.
 */
export function computeNextRefresh(
  cachedRuns: Iterable<[string, WorkflowRun[]]>,
  _workflowDurations: Record<string, number[]>,
  configuredIntervalMs: number,
  now: number = Date.now(),
  lastDiscoveryAt: number = 0,
): AdaptiveRefreshResult {
  const activeRepoSet = new Set<string>();

  for (const [repo, runs] of cachedRuns) {
    for (const run of runs) {
      if (!ACTIVE_STATUSES.has(run.status)) continue;
      activeRepoSet.add(repo);
    }
  }

  const discoveryIntervalMs = Math.min(
    DISCOVERY_REFRESH_INTERVAL_MS,
    configuredIntervalMs,
  );
  const activeIntervalMs = Math.min(
    ACTIVE_REFRESH_INTERVAL_MS,
    configuredIntervalMs,
  );
  const discoveryDelayMs = Math.max(
    0,
    lastDiscoveryAt + discoveryIntervalMs - now,
  );
  const activeDelayMs =
    activeRepoSet.size > 0 ? activeIntervalMs : Number.POSITIVE_INFINITY;
  const refreshAllRepos = discoveryDelayMs <= activeDelayMs;

  const nextDelayMs = Math.min(discoveryDelayMs, activeDelayMs);
  const delayMs = nextDelayMs <= 0 ? MIN_REFRESH_INTERVAL_MS : nextDelayMs;
  return {
    delayMs,
    activeRepos: [...activeRepoSet],
    refreshAllRepos,
  };
}

/**
 * Select a quota-safe subset for a runs-only poll. Each candidate costs one
 * counted REST call. Rotation ensures repeated constrained discovery cycles do
 * not permanently starve the same repositories.
 */
export function selectAffordableRunPollRepos(
  candidates: string[],
  rateLimit: { remaining: number; limit: number } | null,
  floor: number,
  now: number = Date.now(),
): string[] {
  if (!rateLimit) return candidates;

  const affordable = Math.max(0, rateLimit.remaining - floor);
  if (affordable >= candidates.length) return candidates;
  if (affordable === 0 || candidates.length === 0) return [];

  const count = Math.min(affordable, candidates.length);
  const offset =
    Math.floor(now / DISCOVERY_REFRESH_INTERVAL_MS) % candidates.length;
  return Array.from(
    { length: count },
    (_, index) => candidates[(offset + index) % candidates.length],
  );
}

/** Returns the median of a number array, or undefined if empty. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Update workflow duration history with newly completed runs. Returns a new
 * map if any updates were made, or null if nothing changed.
 */
export function updateDurationHistory(
  current: Record<string, number[]>,
  completedRuns: WorkflowRun[],
): Record<string, number[]> | null {
  let changed = false;
  const result = { ...current };

  for (const run of completedRuns) {
    if (run.status !== "completed" || run.duration <= 0) continue;

    const key = run.workflowPath;
    const existing = result[key] ?? [];

    // Skip if the last recorded duration matches — catches the common case of the
    // same completed run appearing in consecutive fetches. Can also skip a genuinely
    // different run with an identical duration, but losing one sample out of 5 is fine.
    if (existing.length > 0 && existing[existing.length - 1] === run.duration)
      continue;

    const updated = [...existing, run.duration];
    if (updated.length > MAX_DURATION_SAMPLES) {
      updated.splice(0, updated.length - MAX_DURATION_SAMPLES);
    }
    result[key] = updated;
    changed = true;
  }

  return changed ? result : null;
}
