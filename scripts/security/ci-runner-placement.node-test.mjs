import assert from "node:assert/strict";
import test from "node:test";
import {
  placementFingerprint,
  placementGraphDigest,
  validateRunnerPlacement,
  workflowPlacementGraph,
} from "./ci-runner-placement.mjs";

const file = ".github/workflows/ci.yml";
const labels = ["self-hosted", "Linux", "X64", "dr-ops"];
const fixture = () => ({
  repository: "fixture/source-policy",
  runners: [labels],
  workflows: { [file]: { jobs: { check: { "runs-on": labels } } } },
  policy: { repositories: { "fixture/source-policy": {} } },
});
const execute = (change) => {
  const input = fixture();
  change?.(input);
  return validateRunnerPlacement(input);
};

test("registered persistent execution is admitted, without checking runner availability", () => {
  assert.equal(execute()[0].kind, "self-hosted");
  assert.equal(
    execute((input) => {
      input.workflows[file].jobs.check["runs-on"] = ["self-hosted", "linux"];
    })[0].kind,
    "self-hosted",
  );
});
test("unknown hosted execution, empty labels and unregistered runner labels fail closed", () => {
  for (const value of [
    "ubuntu-latest",
    "windows-latest",
    [],
    ["self-hosted", "not-registered"],
  ])
    assert.throws(
      () =>
        execute((input) => {
          input.workflows[file].jobs.check["runs-on"] = value;
        }),
      /CI runner placement/,
    );
});
test("hosted exception pins exact job and image and requires an explanation", () => {
  const input = fixture();
  input.workflows[file].jobs.check["runs-on"] = "ubuntu-24.04";
  input.policy.repositories[input.repository].hostedExceptions = {
    [`${file}:check`]: {
      runsOn: "ubuntu-24.04",
      reason:
        "Dependency lifecycle code still requires an ephemeral isolated machine.",
    },
  };
  assert.equal(validateRunnerPlacement(input)[0].kind, "hosted");
  input.workflows[file].jobs.check["runs-on"] = "ubuntu-latest";
  assert.throws(
    () => validateRunnerPlacement(input),
    /exact reviewed exception/,
  );
});
test("unreviewed expressions cannot conceal hosted or arbitrary placement", () => {
  for (const value of [
    "${{ inputs.runner }}",
    "${{ matrix.os }}",
    "${{ fromJSON(needs.select.outputs.runner) }}",
  ])
    assert.throws(
      () =>
        execute((input) => {
          input.workflows[file].jobs.check["runs-on"] = value;
        }),
      /selector/,
    );
});
test("input-based reusable selectors check both defaults and literal caller overrides", () => {
  const input = fixture();
  const reusable = ".github/workflows/telemetry.yml";
  const expression = "${{ fromJSON(inputs.runs_on_json) }}";
  input.workflows[file].jobs.check = {
    uses: `./${reusable}`,
    with: { runs_on_json: JSON.stringify(labels) },
  };
  input.workflows[reusable] = {
    on: {
      workflow_call: {
        inputs: { runs_on_json: { default: JSON.stringify(labels) } },
      },
    },
    jobs: { telemetry: { "runs-on": expression } },
  };
  input.policy.repositories[input.repository].selectors = {
    [`${reusable}:telemetry`]: {
      expression,
      input: "runs_on_json",
      reason:
        "Telemetry may only select a registered persistent caller runner.",
    },
  };
  assert.equal(validateRunnerPlacement(input).length, 2);
  input.workflows[file].jobs.check.with.runs_on_json = '["ubuntu-latest"]';
  assert.throws(() => validateRunnerPlacement(input), /hosted execution/);
  input.workflows[file].jobs.check.with.runs_on_json = "${{ inputs.runner }}";
  assert.throws(() => validateRunnerPlacement(input), /caller override/);
  delete input.workflows[file].jobs.check.with.runs_on_json;
  input.workflows[reusable].on.workflow_call.inputs.runs_on_json.default =
    '["ubuntu-latest"]';
  assert.throws(() => validateRunnerPlacement(input), /hosted execution/);
});
test("pinned remote reusable jobs are inspected, not assumed free or self-hosted", () => {
  const input = fixture();
  const remote =
    "fixture/source-policy/.github/workflows/shared.yml@" + "a".repeat(40);
  input.workflows[file].jobs.check = { uses: remote };
  assert.throws(() => validateRunnerPlacement(input), /not been resolved/);
  input.remoteWorkflows = {
    [remote]: { jobs: { hidden: { "runs-on": "ubuntu-latest" } } },
  };
  assert.throws(() => validateRunnerPlacement(input), /hosted execution/);
  input.remoteWorkflows[remote].jobs.hidden["runs-on"] = labels;
  assert.equal(validateRunnerPlacement(input)[0].kind, "self-hosted");
  input.workflows[file].jobs.check.uses = remote.replace(
    "a".repeat(40),
    "main",
  );
  assert.throws(
    () => validateRunnerPlacement(input),
    /immutable full commit SHA/,
  );
});
test("local reuse cycles, missing workflows and mixed job forms are rejected", () => {
  assert.throws(
    () =>
      execute((input) => {
        input.workflows[file].jobs.check = { uses: `./${file}` };
      }),
    /cyclic/,
  );
  assert.throws(
    () =>
      execute((input) => {
        input.workflows[file].jobs.check = {
          uses: "./.github/workflows/missing.yml",
        };
      }),
    /not been resolved/,
  );
  assert.throws(
    () =>
      execute((input) => {
        input.workflows[file].jobs.check.uses = `./${file}`;
      }),
    /cannot also select/,
  );
});
test("relative reuse inside a remote workflow stays in that repository and immutable revision", () => {
  const input = fixture();
  const pin = "a".repeat(40);
  const remote = `mdotk/central/.github/workflows/shared.yml@${pin}`;
  const nested = `mdotk/central/.github/workflows/nested.yml@${pin}`;
  input.workflows[file].jobs.check = { uses: remote };
  // A same-named caller workflow must not conceal hosted execution remotely.
  input.workflows[".github/workflows/nested.yml"] = {
    jobs: { safe: { "runs-on": labels } },
  };
  input.remoteWorkflows = {
    [remote]: { jobs: { include: { uses: "./.github/workflows/nested.yml" } } },
    [nested]: { jobs: { hidden: { "runs-on": "ubuntu-latest" } } },
  };
  assert.throws(() => validateRunnerPlacement(input), /hosted execution/);
  delete input.remoteWorkflows[nested];
  assert.throws(() => validateRunnerPlacement(input), /not been resolved/);
});
test("unknown repositories are not silently opted into persistent execution", () => {
  assert.throws(
    () =>
      execute((input) => {
        input.repository = "foreign/fork";
      }),
    /unreviewed repository/,
  );
});

const approval = {
  source: "Explicit user-approved runner-placement plan in this chat",
  date: "2026-10-31",
};
function register(input) {
  const rules = input.policy.repositories[input.repository];
  rules.requireRegisteredJobs = true;
  rules.jobs = Object.fromEntries(
    Object.entries(input.workflows).flatMap(([file, doc]) =>
      Object.keys(doc.jobs).map((job) => [
        `${file}:${job}`,
        {
          fingerprint: placementFingerprint(doc, job),
          executionClass: "existing-reviewed",
          approval,
          reason:
            "Preserve the explicitly reviewed execution context and registered runner placement.",
        },
      ]),
    ),
  );
}

test("the classified register rejects new self-hosted jobs and changed source, permissions, events or capacity", () => {
  const input = fixture();
  register(input);
  assert.equal(validateRunnerPlacement(input)[0].kind, "self-hosted");
  const changes = [
    (value) => {
      value.workflows[file].jobs.extra = { "runs-on": labels };
    },
    (value) => {
      value.workflows[file].on = { pull_request_target: null };
    },
    (value) => {
      value.workflows[file].permissions = { contents: "write" };
    },
    (value) => {
      value.workflows[file].jobs.check.permissions = { packages: "write" };
    },
    (value) => {
      value.workflows[file].jobs.check["timeout-minutes"] = 120;
    },
    (value) => {
      value.workflows[file].jobs.check.if = "always()";
    },
    (value) => {
      value.workflows[file].jobs.check.steps = [
        {
          uses: "actions/checkout@" + "a".repeat(40),
          with: { ref: "${{ inputs.untrusted }}" },
        },
      ];
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(input);
    change(changed);
    assert.throws(() => validateRunnerPlacement(changed), /not classified/);
  }
  input.policy.repositories[input.repository].jobs[`${file}:check`].approval =
    {};
  assert.throws(() => validateRunnerPlacement(input), /approval provenance/);
});

test("reviewed immutable reusable graphs are consumed offline, while unknown pins and changed graphs fail", () => {
  const input = fixture(),
    remote = "mdotk/central/.github/workflows/shared.yml@" + "a".repeat(40);
  input.workflows[file].jobs.check = { uses: remote };
  const document = workflowPlacementGraph({
    on: { workflow_call: {} },
    jobs: { install: { "runs-on": "ubuntu-24.04" } },
  });
  input.policy.reusables = {
    [remote]: {
      sourceSha256: "b".repeat(64),
      document,
      graphSha256: placementGraphDigest(document),
      rules: {
        hostedExceptions: {
          [`${remote}:install`]: {
            runsOn: "ubuntu-24.04",
            approval,
            reason:
              "Retain ephemeral dependency lifecycle isolation at this reviewed immutable source pin.",
          },
        },
      },
    },
  };
  register(input);
  assert.equal(validateRunnerPlacement(input)[0].kind, "hosted");
  const altered = structuredClone(input);
  altered.policy.reusables[remote].document.jobs.install["runs-on"] =
    "windows-latest";
  assert.throws(() => validateRunnerPlacement(altered), /invalid immutable/);
  const unknown = structuredClone(input);
  unknown.workflows[file].jobs.check.uses = remote.replace(
    "a".repeat(40),
    "c".repeat(40),
  );
  register(unknown);
  assert.throws(() => validateRunnerPlacement(unknown), /not been resolved/);
});

test("runner matrices preserve every reviewed platform rather than collapsing coverage to Linux", () => {
  const input = fixture(),
    choices = ["ubuntu-latest", "macos-latest", "windows-latest"];
  input.workflows[file].jobs.check = {
    "runs-on": "${{ matrix.os }}",
    strategy: { matrix: { os: choices } },
  };
  const rules = input.policy.repositories[input.repository];
  rules.selectors = {
    [`${file}:check`]: {
      expression: "${{ matrix.os }}",
      matrixKey: "os",
      alternatives: choices,
      reason:
        "Preserve the approved public repository cross-platform verification matrix.",
    },
  };
  rules.hostedExceptions = {
    [`${file}:check`]: {
      runsOnAlternatives: choices,
      approval,
      reason:
        "Public cross-platform verification is deliberately retained, not paid private Linux compute.",
    },
  };
  register(input);
  assert.deepEqual(
    validateRunnerPlacement(input).map((row) => row.runsOn),
    choices,
  );
  input.workflows[file].jobs.check.strategy.matrix.os = ["ubuntu-latest"];
  register(input);
  assert.throws(() => validateRunnerPlacement(input), /matrix differs/);
});

test("only display input descriptions are excluded from identity, never functional fields with that name", () => {
  const doc = {
    on: {
      workflow_dispatch: {
        inputs: {
          mode: { type: "string", default: "safe", description: "Old wording" },
        },
      },
    },
    jobs: {
      check: {
        "runs-on": "${{ matrix.description }}",
        strategy: { matrix: { description: ["ubuntu-latest"] } },
      },
    },
  };
  const original = placementFingerprint(doc, "check");
  doc.on.workflow_dispatch.inputs.mode.description = "New wording";
  assert.equal(placementFingerprint(doc, "check"), original);
  doc.jobs.check.strategy.matrix.description = ["windows-latest"];
  assert.notEqual(placementFingerprint(doc, "check"), original);
});

test("a sidecar cannot bless an unbounded output or caller-controlled selector by listing benign alternatives", () => {
  for (const expression of [
    "${{ fromJSON(needs.pick.outputs.runner) }}",
    "${{ fromJSON(inputs.runner) }}",
    "${{ fromJSON(inputs.candidate_runner) }}",
  ]) {
    const input = fixture();
    input.workflows[file].jobs.check["runs-on"] = expression;
    input.policy.repositories[input.repository].selectors = {
      [`${file}:check`]: {
        expression,
        alternatives: [labels],
        reason:
          "This synthetic declaration must not bypass derived-value qualification.",
      },
    };
    register(input);
    assert.throws(
      () => validateRunnerPlacement(input),
      /separately qualified|reviewed direct input/,
    );
  }
});
