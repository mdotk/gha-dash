# JavaScript dependency install-script policy

gha-dash uses a standalone public install-script policy. It contains no private
repository references, infrastructure inventory, credentials, or deployment
details.

npm 11.17.0 installs the lockfile in strict mode. The required esbuild installer
is enabled, while optional macOS `fsevents` and MSW's promotional postinstall
are explicitly denied. Any new lifecycle-script owner fails the dedicated
workflow until its exact package and version are reviewed.

The primary build matrix uses the same strict install contract on exact Node 20,
22 and 24 releases. PostCSS 8.5.25 is pinned to clear the current development
tooling advisory; production dependencies remain audit-clean.
