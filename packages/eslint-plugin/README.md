<p align="center">
<img src="https://raw.githubusercontent.com/softarc-consulting/sheriff/main/logo.png" width="320" style="text-align: center">
</p>

Sheriff enforces module boundaries and dependency rules in TypeScript.

This is the package for ESLint. You should download it together with the core package.

For more information, please go to https://github.com/softarc-consulting/sheriff.

## Daemon bridge (experimental, opt-in)

Set `SHERIFF_DAEMON=1` to route ESLint checks through a running Sheriff daemon.
Start the daemon with `sheriff daemon start` before running ESLint.

The bridge uses two distinct timeouts. A short connection timeout of
approximately 200 ms decides daemon availability: if the daemon cannot be
reached, the plugin permanently falls back to in-process checks for the rest of
the ESLint process, which makes the opt-in safe and deterministic in CI
environments where the daemon is unavailable. A separate, larger per-call
timeout (default 5000 ms, configurable via `SHERIFF_DAEMON_TIMEOUT_MS`) bounds
each lint round-trip, including the daemon's cold start on the first request. A
single slow call falls back in-process for that file only; the bridge is
disabled permanently only after several consecutive per-call failures.
