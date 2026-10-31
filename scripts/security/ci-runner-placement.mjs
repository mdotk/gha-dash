import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const expression = (value) =>
  typeof value === "string" && value.includes("${{");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const labels = (value) => (Array.isArray(value) ? value : [value]);
const key = (file, job) => `${file}:${job}`;
const fail = (message) => {
  throw new Error(`CI runner placement: ${message}`);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const placementGraphDigest = digest;

function eventContext(value) {
  const result = structuredClone(value || {});
  // Only GitHub's display-only input descriptions are irrelevant. A matrix,
  // environment or reusable argument actually named "description" is data.
  for (const event of ["workflow_call", "workflow_dispatch"])
    for (const input of Object.values(result?.[event]?.inputs || {}))
      if (input && typeof input === "object") delete input.description;
  return result;
}

export function workflowPlacementGraph(document) {
  return {
    on: eventContext(document.on),
    permissions: document.permissions ?? null,
    env: document.env || {},
    jobs: Object.fromEntries(
      Object.entries(document.jobs || {}).map(([id, job]) => [
        id,
        {
          ...Object.fromEntries(
            [
              "runs-on",
              "uses",
              "if",
              "needs",
              "with",
              "permissions",
              "timeout-minutes",
              "concurrency",
              "container",
              "environment",
              "strategy",
              "env",
            ]
              .filter((field) => job[field] !== undefined)
              .map((field) => [field, job[field]]),
          ),
          steps: (job.steps || [])
            .filter((step) => step.uses?.startsWith("actions/checkout@"))
            .map((step) => ({
              uses: step.uses,
              with: step.with || {},
              if: step.if ?? null,
            })),
        },
      ]),
    ),
  };
}

export function placementFingerprint(document, id) {
  const graph = workflowPlacementGraph(document);
  return digest({
    on: graph.on,
    permissions: graph.permissions,
    env: graph.env,
    job: graph.jobs[id],
  });
}

function runnerKind(value, runners, location) {
  const required = labels(value);
  if (
    !required.length ||
    required.some(
      (label) => typeof label !== "string" || !label || expression(label),
    )
  )
    fail(`${location}: runner labels must be explicit non-empty strings`);
  const normalized = required.map((label) => label.toLowerCase());
  if (!normalized.includes("self-hosted")) return "hosted";
  if (
    !runners.some((runner) =>
      normalized.every((label) =>
        runner.map((item) => item.toLowerCase()).includes(label),
      ),
    )
  )
    fail(
      `${location}: no registered caller runner satisfies ${JSON.stringify(value)}`,
    );
  return "self-hosted";
}

// This is a source-policy check, not a sandbox or a runner-health probe. Remote
// documents must be supplied from reviewed immutable pins; never resolve a tag.
export function validateRunnerPlacement({
  repository,
  workflows,
  policy,
  runners,
  remoteWorkflows = {},
}) {
  const rules = policy.repositories?.[repository];
  if (!rules) fail(`unreviewed repository ${repository}`);
  const report = [];
  if (rules.requireRegisteredJobs) {
    const changes = [];
    for (const [file, document] of Object.entries(workflows))
      for (const id of Object.keys(document.jobs || {})) {
        const location = key(file, id),
          fingerprint = placementFingerprint(document, id);
        if (rules.jobs?.[location]?.fingerprint !== fingerprint)
          changes.push(`${location}: ${fingerprint}`);
      }
    if (changes.length)
      fail(
        `new or changed placement/context is not classified (${changes.length} job(s)); review the workflow diff before using observed fingerprints:\n${changes.slice(0, 50).join("\n")}`,
      );
  }

  function check(value, location, reason, sourceRules) {
    const kind = runnerKind(value, runners, location);
    if (kind === "hosted") {
      const approved = sourceRules.hostedExceptions?.[location];
      const alternatives = approved?.runsOnAlternatives || [approved?.runsOn];
      if (
        !approved ||
        !alternatives.some((choice) => equal(choice, value)) ||
        typeof approved.reason !== "string" ||
        approved.reason.trim().length < 20
      )
        fail(
          `${location}: GitHub-hosted execution has no exact reviewed exception`,
        );
      if (
        sourceRules.requireRegisteredJobs &&
        (!approved.approval?.source || !approved.approval?.date)
      )
        fail(`${location}: hosted exception approval provenance is missing`);
    }
    report.push({
      location,
      runsOn: value,
      kind,
      reason:
        reason || sourceRules.hostedExceptions?.[location]?.reason || null,
    });
  }

  function visit(file, document, inputs = {}, stack = [], sourceRules = rules) {
    if (stack.includes(file) || stack.length >= 10)
      fail(`${file}: cyclic or over-depth reusable workflow`);
    if (
      !document?.jobs ||
      typeof document.jobs !== "object" ||
      Array.isArray(document.jobs)
    )
      fail(`${file}: workflow jobs are missing or malformed`);
    for (const [jobId, job] of Object.entries(document.jobs)) {
      const location = key(file, jobId);
      if (!job || typeof job !== "object") fail(`${location}: malformed job`);
      if (sourceRules.requireRegisteredJobs) {
        const record = sourceRules.jobs?.[location];
        if (
          !record ||
          record.fingerprint !== placementFingerprint(document, jobId)
        )
          fail(
            `${location}: new or changed placement/context is not classified in the job register; observed fingerprint ${placementFingerprint(document, jobId)}`,
          );
        if (
          !record.executionClass ||
          !record.approval?.source ||
          !/^\d{4}-\d{2}-\d{2}$/.test(record.approval?.date || "") ||
          typeof record.reason !== "string" ||
          record.reason.trim().length < 20
        )
          fail(
            `${location}: execution class and approval provenance are required`,
          );
      }
      if (job.uses) {
        if (job["runs-on"] !== undefined)
          fail(`${location}: reusable job cannot also select a runner`);
        let target, source;
        if (job.uses.startsWith("./.github/workflows/")) {
          target = job.uses.slice(2);
          if (path.posix.normalize(target) !== target)
            fail(`${location}: non-canonical reusable workflow path`);
          if (file.includes("@")) {
            const parent = file.match(
              /^([^/]+\/[^/]+)\/\.github\/workflows\/[^@]+@([a-f0-9]{40})$/,
            );
            if (!parent)
              fail(`${location}: malformed external reusable parent`);
            target = `${parent[1]}/${target}@${parent[2]}`;
            source = remoteWorkflows[target];
          } else source = workflows[target];
        } else {
          if (
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[a-f0-9]{40}$/.test(
              job.uses,
            )
          )
            fail(
              `${location}: external reusable workflow must use an immutable full commit SHA`,
            );
          target = job.uses;
          source = remoteWorkflows[target];
        }
        const snapshot = policy.reusables?.[target];
        if (snapshot) {
          if (
            !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256 || "") ||
            snapshot.graphSha256 !== digest(snapshot.document)
          )
            fail(`${location}: invalid immutable reusable placement evidence`);
          if (
            source &&
            !equal(
              canonical(workflowPlacementGraph(source)),
              canonical(snapshot.document),
            )
          )
            fail(
              `${location}: resolved reusable differs from its reviewed immutable placement graph`,
            );
          source ||= snapshot.document;
        }
        if (!source)
          fail(
            `${location}: reusable workflow ${target} has not been resolved and reviewed`,
          );
        if (rules.requireRegisteredJobs && target.includes("@") && !snapshot)
          fail(
            `${location}: reusable pin is not registered with immutable source evidence`,
          );
        visit(
          target,
          source,
          job.with || {},
          [...stack, file],
          snapshot?.rules || sourceRules,
        );
        continue;
      }
      const value = job["runs-on"];
      if (!expression(value)) {
        check(value, location, null, sourceRules);
        continue;
      }
      const approved = sourceRules.selectors?.[location];
      if (
        !approved ||
        approved.expression !== value ||
        typeof approved.reason !== "string" ||
        approved.reason.trim().length < 20
      )
        fail(
          `${location}: dynamic runner selector has not been reviewed exactly`,
        );
      if (approved.input) {
        if (value !== "${{ fromJSON(inputs." + approved.input + ") }}")
          fail(
            `${location}: input selector is not the reviewed direct JSON-label selector`,
          );
        const raw =
          inputs[approved.input] ??
          document.on?.workflow_call?.inputs?.[approved.input]?.default;
        if (typeof raw !== "string" || expression(raw))
          fail(`${location}: dynamic caller override needs separate review`);
        let selected;
        try {
          selected = JSON.parse(raw);
        } catch {
          fail(`${location}: invalid JSON runner override`);
        }
        check(selected, location, approved.reason, sourceRules);
      } else {
        if (
          !approved.matrixKey &&
          /\b(?:needs|steps|env|vars|secrets|matrix)\s*[.\[]/.test(value)
        )
          fail(
            `${location}: derived runner values require a separately qualified selector contract`,
          );
        if (
          !approved.matrixKey &&
          /\binputs\s*[.\[]/.test(value.replace(/\binputs\.candidate\b/g, ""))
        )
          fail(
            `${location}: caller-controlled runner values require the reviewed direct input selector`,
          );
        if (
          approved.matrixKey &&
          value !== "${{ matrix." + approved.matrixKey + " }}"
        )
          fail(
            `${location}: matrix selector must directly select its reviewed matrix key`,
          );
        if (
          !Array.isArray(approved.alternatives) ||
          !approved.alternatives.length
        )
          fail(`${location}: reviewed selector alternatives are missing`);
        if (
          approved.matrixKey &&
          !equal(
            document.jobs[jobId].strategy?.matrix?.[approved.matrixKey],
            approved.alternatives,
          )
        )
          fail(
            `${location}: runner matrix differs from its reviewed alternatives`,
          );
        for (const alternative of approved.alternatives)
          check(alternative, location, approved.reason, sourceRules);
      }
    }
  }

  for (const [file, document] of Object.entries(workflows))
    visit(file, document);
  if (rules.requireRegisteredJobs) {
    const actual = new Set(
      Object.entries(workflows).flatMap(([file, document]) =>
        Object.keys(document.jobs).map((job) => key(file, job)),
      ),
    );
    for (const location of Object.keys(rules.jobs || {}))
      if (!actual.has(location))
        fail(
          `${location}: classified job no longer exists; reconcile the register explicitly`,
        );
  }
  return report;
}

export async function readWorkflowDocuments(root, yaml) {
  root = await fs.realpath(root);
  const directory = path.join(root, ".github/workflows");
  if ((await fs.realpath(directory)) !== directory)
    fail("workflow directory must not traverse a symlink");
  const documents = {};
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!/\.ya?ml$/.test(entry.name)) continue;
    if (!entry.isFile()) fail(`${entry.name}: workflow must be a regular file`);
    const file = `.github/workflows/${entry.name}`;
    const info = await fs.stat(path.join(root, file));
    bytes += info.size;
    if (
      Object.keys(documents).length >= 256 ||
      info.size > 1024 * 1024 ||
      bytes > 8 * 1024 * 1024
    )
      fail("workflow inventory exceeds the bounded source-review budget");
    const parsed = yaml.parseDocument(
      await fs.readFile(path.join(root, file), "utf8"),
      { uniqueKeys: true },
    );
    if (parsed.errors.length) fail(`${file}: ${parsed.errors[0].message}`);
    documents[file] = parsed.toJS();
  }
  return documents;
}
