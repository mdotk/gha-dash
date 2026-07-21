import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCoolifySnapshot,
  validateCoolifySnapshot,
} from "../coolifySnapshot.js";

const validState = {
  schemaVersion: 1,
  source: "https://app.coolify.io",
  generatedAt: "2026-07-21T22:39:21Z",
  lastAttemptAt: "2026-07-21T22:39:21Z",
  staleAfterSeconds: 180,
  error: null,
  resources: [
    {
      uuid: "app-1",
      name: "example",
      type: "application",
      status: "running:healthy",
      project: "Production",
      environment: "production",
      image: "ghcr.io/example/app",
      imageTag: "sha-abc1234",
      repository: "example/app",
      registered: true,
      dashboardUrl:
        "https://app.coolify.io/project/p/environment/e/application/a",
      activeDeployment: null,
      latestDeployment: {
        uuid: "deployment-1",
        status: "finished",
        startedAt: "2026-07-21T22:37:35Z",
        finishedAt: "2026-07-21T22:39:21Z",
      },
    },
  ],
} as const;

describe("Coolify snapshot validation", () => {
  it("accepts the sanitized versioned contract", () => {
    expect(validateCoolifySnapshot(validState).resources).toHaveLength(1);
  });

  it("rejects non-Coolify links", () => {
    expect(() =>
      validateCoolifySnapshot({
        ...validState,
        resources: [
          { ...validState.resources[0], dashboardUrl: "https://example.com" },
        ],
      }),
    ).toThrow("schema validation");
  });

  it("rejects extra-shaped raw API resources", () => {
    expect(() =>
      validateCoolifySnapshot({
        ...validState,
        resources: [
          { ...validState.resources[0], status: "running\nsecret=x" },
        ],
      }),
    ).toThrow("schema validation");
  });

  it("reads a valid state file", async () => {
    const path = join(tmpdir(), `gha-dash-coolify-${process.pid}.json`);
    await writeFile(path, JSON.stringify(validState), { mode: 0o600 });
    const state = await readCoolifySnapshot(path);
    expect(state.source).toBe("https://app.coolify.io");
  });
});
