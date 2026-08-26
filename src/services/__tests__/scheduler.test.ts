import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../../types.js";
import {
  ACTIVE_REFRESH_INTERVAL_MS,
  computeNextRefresh,
  DISCOVERY_REFRESH_INTERVAL_MS,
  MAX_DURATION_SAMPLES,
  median,
  MIN_REFRESH_INTERVAL_MS,
  selectAffordableRunPollRepos,
  updateDurationHistory,
} from "../scheduler.js";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    workflowId: 1,
    workflowName: "ci",
    repo: "owner/repo",
    status: "completed",
    conclusion: "success",
    branch: "main",
    commitSha: "abc1234",
    commitMessage: "test",
    duration: 300_000,
    createdAt: new Date().toISOString(),
    htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    workflowPath: ".github/workflows/ci.yml",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function entries(repo: string, runs: WorkflowRun[]): [string, WorkflowRun[]][] {
  return [[repo, runs]];
}

describe("median", () => {
  it("returns undefined for empty input", () => {
    expect(median([])).toBeUndefined();
  });

  it("returns the single element", () => {
    expect(median([42])).toBe(42);
  });

  it("returns the middle value for odd-length input", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the middle values for even-length input", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

describe("computeNextRefresh", () => {
  const configuredInterval = 3_600_000;
  const now = 1_800_000_000_000;

  it("discovers a build that starts while every repository is idle", () => {
    const result = computeNextRefresh(
      entries("owner/repo", [makeRun({ status: "completed" })]),
      {},
      configuredInterval,
      now,
      now,
    );

    expect(result).toEqual({
      delayMs: DISCOVERY_REFRESH_INTERVAL_MS,
      activeRepos: [],
      refreshAllRepos: true,
    });
  });

  it("performs an initial discovery promptly when no scan time is known", () => {
    const result = computeNextRefresh([], {}, configuredInterval, now, 0);

    expect(result.delayMs).toBe(MIN_REFRESH_INTERVAL_MS);
    expect(result.refreshAllRepos).toBe(true);
  });

  it("keeps long-running workflows current instead of sleeping until predicted completion", () => {
    const result = computeNextRefresh(
      entries("owner/repo", [
        makeRun({
          status: "in_progress",
          conclusion: null,
          startedAt: new Date(now - 7_200_000).toISOString(),
        }),
      ]),
      { ".github/workflows/ci.yml": [14_400_000] },
      configuredInterval,
      now,
      now,
    );

    expect(result.delayMs).toBe(ACTIVE_REFRESH_INTERVAL_MS);
    expect(result.activeRepos).toEqual(["owner/repo"]);
    expect(result.refreshAllRepos).toBe(false);
  });

  it.each(["success", "cancelled"] as const)(
    "returns a completed or %s run to the discovery cadence",
    (conclusion) => {
      const result = computeNextRefresh(
        entries("owner/repo", [makeRun({ status: "completed", conclusion })]),
        {},
        configuredInterval,
        now,
        now,
      );

      expect(result.delayMs).toBe(DISCOVERY_REFRESH_INTERVAL_MS);
      expect(result.activeRepos).toEqual([]);
      expect(result.refreshAllRepos).toBe(true);
    },
  );

  it("prioritizes the all-repository discovery when it becomes due", () => {
    const result = computeNextRefresh(
      entries("owner/active", [
        makeRun({ status: "queued", conclusion: null }),
      ]),
      {},
      configuredInterval,
      now,
      now - 45_000,
    );

    expect(result.delayMs).toBe(15_000);
    expect(result.activeRepos).toEqual(["owner/active"]);
    expect(result.refreshAllRepos).toBe(true);
  });

  it("returns only repositories with active runs", () => {
    const result = computeNextRefresh(
      [
        ["owner/idle", [makeRun({ status: "completed" })]],
        ["owner/active", [makeRun({ status: "waiting", conclusion: null })]],
      ],
      {},
      configuredInterval,
      now,
      now,
    );

    expect(result.activeRepos).toEqual(["owner/active"]);
    expect(result.delayMs).toBe(ACTIVE_REFRESH_INTERVAL_MS);
  });

  it("honors a deliberately shorter configured full-refresh interval", () => {
    const result = computeNextRefresh([], {}, 20_000, now, now);

    expect(result.delayMs).toBe(20_000);
    expect(result.refreshAllRepos).toBe(true);
  });
});

describe("selectAffordableRunPollRepos", () => {
  const repos = ["owner/a", "owner/b", "owner/c"];

  it("polls every candidate when quota is healthy", () => {
    expect(
      selectAffordableRunPollRepos(
        repos,
        { remaining: 4_999, limit: 5_000 },
        500,
      ),
    ).toEqual(repos);
  });

  it("backs off completely at the configured quota floor", () => {
    expect(
      selectAffordableRunPollRepos(
        repos,
        { remaining: 500, limit: 5_000 },
        500,
      ),
    ).toEqual([]);
  });

  it("rotates a constrained subset so repositories are not starved", () => {
    const first = selectAffordableRunPollRepos(
      repos,
      { remaining: 501, limit: 5_000 },
      500,
      0,
    );
    const second = selectAffordableRunPollRepos(
      repos,
      { remaining: 501, limit: 5_000 },
      500,
      DISCOVERY_REFRESH_INTERVAL_MS,
    );

    expect(first).toEqual(["owner/a"]);
    expect(second).toEqual(["owner/b"]);
  });
});

describe("updateDurationHistory", () => {
  it("creates and appends workflow duration samples", () => {
    const created = updateDurationHistory({}, [makeRun({ duration: 200_000 })]);
    expect(created).toEqual({ ".github/workflows/ci.yml": [200_000] });

    const appended = updateDurationHistory(created!, [
      makeRun({ duration: 300_000 }),
    ]);
    expect(appended).toEqual({
      ".github/workflows/ci.yml": [200_000, 300_000],
    });
  });

  it("skips a duplicate final sample from the same re-fetched run", () => {
    expect(
      updateDurationHistory({ ".github/workflows/ci.yml": [300_000] }, [
        makeRun({ duration: 300_000 }),
      ]),
    ).toBeNull();
  });

  it("caps history at MAX_DURATION_SAMPLES", () => {
    const result = updateDurationHistory(
      { ".github/workflows/ci.yml": [100, 200, 300, 400, 500] },
      [makeRun({ duration: 600 })],
    );

    expect(result![".github/workflows/ci.yml"]).toHaveLength(
      MAX_DURATION_SAMPLES,
    );
    expect(result![".github/workflows/ci.yml"]).toEqual([
      200, 300, 400, 500, 600,
    ]);
  });

  it("ignores incomplete and zero-duration runs", () => {
    expect(
      updateDurationHistory({}, [
        makeRun({ status: "in_progress", conclusion: null }),
        makeRun({ duration: 0 }),
      ]),
    ).toBeNull();
  });

  it("ignores negative-duration runs", () => {
    expect(updateDurationHistory({}, [makeRun({ duration: -1 })])).toBeNull();
  });

  it("returns null when there are no new runs", () => {
    expect(updateDurationHistory({}, [])).toBeNull();
  });

  it("does not mutate the original history", () => {
    const current = { ".github/workflows/ci.yml": [200_000] };
    updateDurationHistory(current, [makeRun({ duration: 300_000 })]);
    expect(current).toEqual({ ".github/workflows/ci.yml": [200_000] });
  });
});
