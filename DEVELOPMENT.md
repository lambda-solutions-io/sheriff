# About Sheriff

Sheriff consists of three processes:

1. File Graph: `traverseFilesystem` gets and entry file and returns a graph of all the files that are required to run
   the entry file. The final type of the graph is `UnassignedFileInfo`, meaning graph without modules.
2. Modules: Based on `FileInfo`, `createModules` detects the existing modules and their dependencies. The final type of
   the modules is `ModuleInfo`.
3. Merging FileGraph and Modules: `FileInfo` is the final type of the graph that contains all the information about the
   files and modules. It is done by

The entry point is always the `init` function.

# Development

## Setup

We are using `yarn` as our package manager. To install all dependencies, run the following command:

```shell
yarn install
```

## Run local integration tests

We can use Sheriff locally against the projects in the `test-projects`-folder in order to verify that the tool works as
expected. The following steps are required to run the tests:

1. **Build Sheriff**: `yarn build:all`
2. **Link Sheriff**: `yarn link:sheriff`
3. **Run the integration tests**: Execute one of the `integration-test.sh`-scripts within the tests projects or run all by executing the `run-integration-tests.sh`.

## Performance regression checks

The normal Vitest suite always runs deterministic cache and operation-count
guards. Wall-clock scaling is intentionally opt-in so shared CI load cannot
make it flaky:

```shell
SHERIFF_PERF=1 yarn vitest run packages/core/src/lib/main/init-performance.perf.spec.ts
```

For a reproducible CLI baseline, build Sheriff and run the benchmark harness:

```shell
yarn build:all
yarn perf:bench
yarn perf:bench:compare
```

The harness regenerates four projects below ignored `tmp/perf` — 2,101-file
and 10,501-file barrel projects, plus 1,801-file and 9,001-file barrel-less
variants whose module config uses a `**` glob (`'src/app/**/<type>'`), so
config-based discovery and glob tagging are guarded too. It runs `verify`
three times per size and records each median in `tools/perf/baseline.json`.
`perf:bench:compare` leaves the baseline unchanged and fails when any median
is more than 25% slower. Review machine and Node version differences before
treating a comparison as a code regression. To accept an intentional
performance change, rerun `yarn perf:bench`, inspect the new table, and
commit the updated baseline.

# Fork maintenance (@lambda-solutions/sheriff)

This repository is a fork of [softarc-consulting/sheriff](https://github.com/softarc-consulting/sheriff),
published to npm under the `@lambda-solutions` scope (`@lambda-solutions/sheriff-core`,
`@lambda-solutions/eslint-plugin-sheriff`).

## Pulling changes from upstream (cherry-pick on demand)

The original repo is configured as the `upstream` remote. We do **not** auto-merge; we cherry-pick
the commits we want.

```shell
git fetch upstream
git log --oneline main..upstream/main   # review what's new upstream
git checkout -b chore/sync-upstream
git cherry-pick <sha> [<sha> ...]       # pick the wanted commits
```

Conflicts are almost always the scope rename (`@softarc/...` → `@lambda-solutions/...`). Resolve by
keeping the `@lambda-solutions` scope. After resolving, run `yarn build:all`, `yarn test:ci`, and
`yarn lint:all` before opening a PR into `main`.

## Releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please) via
`.github/workflows/release-please.yml` (triggered on push to the `release-please` branch). Conventional
commits drive the version bump; both packages are linked-versioned. On release the workflow builds
`dist/` and runs `npm publish dist/packages/*` using the `NPM_TOKEN` repo secret.
