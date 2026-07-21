# Maintained Patches

## Uncached GitHub Actions runs

Base: upstream `v0.8.3` (`47d879bfaacbbfdcbe0c65f05c9144a15c1d7d25`)

Upstream issue: https://github.com/photostructure/gha-dash/issues/4

GitHub's Actions-runs endpoint returned stale conditional responses in the
deployed dashboard, leaving completed and failed jobs displayed as
`in_progress` or `queued`. The existing per-request ETag bypass did not prevent
the stale state in production.

The patch creates two authenticated Octokit clients from the same in-memory
token:

- `octokit` retains the ETag hook for repository and workflow metadata, PR
  counts, and rate-limit checks.
- `runsOctokit` never receives the ETag hook and is used only by
  `actions.listWorkflowRunsForRepo` during full, manual, and active refreshes.
  Its request hook strips conditional validators and sends
  `Cache-Control: no-cache`, preventing the long-lived process or an
  intermediary from reusing stale transition state.
- `fetchActiveWorkflowIds` retains ETag caching but uses explicit page reads.
  Octokit's paginator mutates the cached workflow-list response, causing the
  first 304 refresh to produce an empty active-ID set and filter out every
  fresh run. The explicit loop leaves cached metadata intact.

No token logging, persistence, new API permissions, or new outbound destination
is introduced. Both clients talk to `api.github.com` through `@octokit/rest`.

### Dependency audit

- Production `qs` was resolved from `6.15.0` to `6.15.3` to address
  `GHSA-q8mj-m7cp-5q26`.
- `npm audit --omit=dev`: zero vulnerabilities.
- Non-breaking dev remediation updated Vite to `8.1.4` and fixed the prior
  `concurrently`/`shell-quote`, `form-data`, Vite, and `brace-expansion`
  findings.
- Accepted residual: low-severity `GHSA-g7r4-m6w7-qqqr` in esbuild `0.27.5`,
  reached only through the tsup build tool. The advisory affects the esbuild
  development server on Windows; this project builds on macOS/Linux and does
  not ship esbuild in the runtime tree. Forcing esbuild `0.28.1` would override
  tsup `8.5.1`'s declared `^0.27.0` range.

### Re-apply after an upstream update

1. Create a branch from the new upstream release.
2. Re-apply `createRunsOctokit`, including its runs-only no-cache hook, plus
   the `runsOctokit` state field, initialization, 401-token refresh, and the
   three `fetchWorkflowRuns` call sites in `src/state.ts`.
3. Pass `runsOctokit` separately through `fetchAllRuns` and remove the
   `SKIP_ETAG_CACHE_HEADER` marker from the Actions-runs request in
   `src/services/github.ts`.
4. Keep the explicit pagination loop in `fetchActiveWorkflowIds`; do not
   replace it with `octokit.paginate` while metadata uses the ETag hook.
5. Re-apply the regression assertions in
   `src/services/__tests__/refreshRepoActive.test.ts` and
   `src/services/__tests__/github-api.test.ts`.
6. Run `npm audit --omit=dev`, formatting, lint, all tests, and the production
   build before deployment.
7. Remove this patch and return to the clean upstream package once issue #4 is
   fixed and the same live failure-transition acceptance test passes upstream.

## Hosted Coolify deployment state

The maintained fork can display a versioned, sanitized Coolify Cloud snapshot
above the GitHub Actions table. API access deliberately remains outside this
process: a separate least-privilege collector owns the team-scoped `read`
token, and `gha-dash` only reads `/var/lib/coolify-monitor/state.json`.

The `/api/coolify` route validates the complete snapshot contract, rejects
unexpected origins and malformed fields, disables HTTP caching, and never
accepts a token. The Vue panel shows current resource health, immutable image
tags or repositories, active and latest deployments, stale-state warnings, and
resources that are not yet registered in the infrastructure inventory.

The source lock also resolves `body-parser` to `2.3.0`, clearing
`GHSA-v422-hmwv-36x6`; `npm audit --omit=dev` remains a zero-vulnerability ship
gate.

When rebasing, re-apply the snapshot types, validator/reader, read-only route,
client composable and panel, then rerun the route, schema, formatting, lint,
build, and production-audit gates. Do not move the Coolify credential or API
client into this process.
