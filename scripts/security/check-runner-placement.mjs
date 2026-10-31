import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import * as yaml from "yaml";
import {
  readWorkflowDocuments,
  validateRunnerPlacement,
} from "./ci-runner-placement.mjs";

// Standalone public equivalent: no private action, credentials or runner inventory.
const root = process.cwd();
const repository = process.env.GITHUB_REPOSITORY || "mdotk/gha-dash";
assert.equal(
  repository,
  "mdotk/gha-dash",
  "Reconcile the public register before adopting it in another repository",
);
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA) {
  assert.equal(git(["rev-parse", "HEAD"]), process.env.GITHUB_SHA);
  assert.equal(
    git([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".github/workflows",
      ".github/ci-runner-placement.json",
      "scripts/security",
    ]),
    "",
    "Placement inputs must match the committed event source",
  );
}
const policyFile = ".github/ci-runner-placement.json";
const info = await fs.lstat(policyFile);
assert.ok(
  info.isFile() && !info.isSymbolicLink() && info.size < 5 * 1024 * 1024,
);
const policy = JSON.parse(
  await fs.readFile(".github/ci-runner-placement.json", "utf8"),
);
assert.equal(policy.repositories[repository].requireRegisteredJobs, true);
const report = validateRunnerPlacement({
  repository,
  policy,
  runners: [],
  workflows: await readWorkflowDocuments(root, yaml),
});
console.log(
  JSON.stringify({
    status: "passed",
    repository,
    jobs: new Set(report.map((r) => r.location)).size,
    placements: report.length,
  }),
);
