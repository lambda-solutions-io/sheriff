# @lambda-solutions/sheriff-watch

Example of a **long-running / interactive** Sheriff plugin that leverages the
project cache.

Both `api.verify()` and `api.getProjectData()` memoize Sheriff's expensive
analysis in a process-level cache. The costly inner steps — parsing configs and
`tsconfig`, building the TypeScript data, resolving imports, and computing the
dependency universe — run once and are reused across calls. A plugin calling
both in the same run does **not** redo that parsing/resolution twice, and a
plugin that re-runs them repeatedly only pays the full cost when a source file
actually changes. (The filesystem traversal and module-graph reconstruction
still run per call; it's the expensive parsing/resolution underneath that is
cached.)

## Usage

`sheriff watch` starts an interactive REPL that stays alive and re-queries
Sheriff on demand. It accepts these commands:

- `verify` — run `api.verify()`
- `data` — run `api.getProjectData()`
- `both` — run `verify` then `data`
- `quit` / `exit` — leave the session (Ctrl-D / Ctrl-C also exit)

```bash
# interactive session (stdin is a TTY)
npx sheriff watch
watch> both
watch> verify
watch> quit
```

Each command prints the **elapsed milliseconds** of every API call, so the
cache benefit is observable rather than asserted: the first `verify`/`data`
pays the cold cost, subsequent calls are visibly faster because the expensive
parsing/resolution is served from the cache.

When stdin is **not** a TTY, the plugin reads the piped command lines, runs
them, and exits — deterministic and non-blocking:

```bash
printf 'both\nquit\n' | npx sheriff watch
```

Configured plugins are not executed by the Sheriff daemon or by
`sheriff verify --watch` — those run Sheriff's built-in verifier — but the
daemon keeps the cache warm across RPC calls, and its watcher invalidates
changed paths and conservatively drops structure-dependent entries on any
change, so any repeated in-process API use stays both cheap and correct.

## Cache environment variables

- `SHERIFF_NO_CACHE=1` — disable caching entirely.
- `SHERIFF_CACHE_TTL=<ms>` — override the staleness window (default 2000ms) for
  directory-structure-dependent results.
