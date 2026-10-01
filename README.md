# 🔁 pi-retry — Retry Hints for Pi Provider Errors

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@perasite/pi-retry` is a fork of `@narumitw/pi-retry` for Pi 0.99.2 or newer. It classifies provider errors as retryable and reports silent streams without cancelling the agent run.

Use it to make Pi sessions more resilient when an upstream AI provider returns a transient unknown error without useful details, Codex reports an explicitly retryable backend failure or asks for a fresh websocket, or a provider stops streaming after Pi has sent a request.

## ✨ Features

- Detects assistant messages that end with `stopReason: "error"`.
- Matches the known provider error text `Unknown error (no error details in response)`.
- Matches Codex `websocket_connection_limit_reached` after a websocket hits its 60-minute limit.
- Matches Codex backend failures that explicitly include `You can retry your request`.
- Appends Pi's retryable-provider-error hint.
- Lets Pi's built-in retry path continue the turn when `retry.enabled` is `true`.
- Warns once when Pi's agent-level retry policy is disabled without changing the setting.
- Watches provider responses, raw provider stream events, and assistant updates for stalls.
- Shows `stalled` and warns after prolonged silence without calling `ctx.abort()`.
- Shows `receiving` while provider/stream events are arriving.
- Shows `retrying` when a matching provider error is classified for Pi's automatic retry.
- Supports `--retry-stall-timeout-ms <ms>` and `PI_RETRY_STALL_TIMEOUT_MS=<ms>` for warning timing.
- Leaves request timeouts, cancellation, retry limits, and backoff to Pi.

## 📦 Install

```bash
pi install git:github.com/PeraSite/pi-retry
```

Try without installing permanently:

```bash
pi -e git:github.com/PeraSite/pi-retry
```

Try this package locally from the repository root:

```bash
pi -e ./src/index.ts
```

Pi's agent-level retry policy must be enabled (the default):

```json
{
  "retry": {
    "enabled": true
  }
}
```

`pi-retry` warns when this policy is disabled, but it never changes the setting automatically.

## 🚀 What it does

When an assistant message ends with `stopReason: "error"` and the error message matches `Unknown error (no error details in response)`, Codex `websocket_connection_limit_reached`, or a Codex processing error that explicitly says `You can retry your request`, the extension appends Pi's retryable-provider-error hint so Pi's built-in retry path can continue the turn.

Pi owns retry attempts, the retry budget, and exponential backoff. `pi-retry` only adds provider-specific classifications and stall detection; it does not implement or enable a separate retry loop. The extension reads Pi's global and trusted-project settings at session start and before provider requests. Current Pi extension contexts do not expose SDK-only in-memory retry overrides, so those overrides cannot be detected yet.

When Pi's retry policy is enabled, the extension starts a warning-only stall watchdog after a provider request. Provider responses, raw provider stream events (including events without text deltas), and assistant updates refresh a `receiving` statusline item. If no activity is observed for 90s, it briefly shows `stalled` and warns, but keeps the request running. Later activity resumes monitoring. Cache-warming requests while tools run do not arm the watchdog. When `retry.enabled` is `false`, stall warnings are disabled.

Version 0.31.0 called `ctx.abort()` and rewrote the resulting cancellation as retryable. In current Pi, that cancels the whole run and suppresses automatic retry. Version 0.32.0 removes this forced cancellation and never rewrites a user's abort. Pi's native provider timeout handles genuine request failures through its ordinary retry policy.

Configure the warning-only watchdog with:

```bash
pi --retry-stall-timeout-ms 10000
PI_RETRY_STALL_TIMEOUT_MS=10000 pi
```

Use `0`, `off`, or `false` to disable stall warnings. These options no longer cancel requests. Configure actual request timeouts with Pi's `httpIdleTimeoutMs` (default `300000`) or `retry.provider.timeoutMs`; retry attempts and backoff remain controlled by Pi's built-in settings.

## 🧠 Use cases

- Reduce manual restarts after transient provider failures.
- Recover from explicitly retryable Codex backend failures or websocket connection limits.
- Improve reliability during long Pi coding agent sessions.
- Keep tool-heavy implementation tasks moving when a provider returns an unknown error or stream stalls.
- Pair with `@narumitw/pi-goal` for more robust autonomous task loops.

## 🗂️ Package layout

```txt
pi-retry/
├── src/
│   ├── index.ts
│   └── retry.ts
├── README.md
├── LICENSE
├── test/retry.test.mjs
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Verification

```bash
npm install --ignore-scripts
npm run check
```

The Node test runner covers silent streams, raw stream activity, tool-time cache warming, cancellation, and retry classification.

## 🔎 Keywords

Pi extension, Pi coding agent, retry, provider error, unknown error, stream stall, watchdog, AI provider reliability, agent resilience, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
