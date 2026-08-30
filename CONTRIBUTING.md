# Contributing

Thank you for improving `electron-state-bridge`.

## Development setup

Use Node.js 22.12 or newer and install the locked dependency graph:

```bash
npm ci
```

Run the full verification path before opening a pull request:

```bash
npm run verify
npm run benchmark:sync
```

The Electron integration and benchmark use Xvfb on Linux. The core tests do not
require Electron and can be run independently with `npm run test:core`.

## Contribution guidelines

- Keep changes focused and include regression coverage for behavioral changes.
- Preserve the main-process single-writer, revision, validation, and recovery
  invariants documented in `docs/design.md`.
- Treat additions to the synchronous action whitelist as security and
  performance-sensitive changes. Include a benchmark and justify the blocking
  behavior.
- Do not commit credentials, real transcripts, customer data, local paths, or
  generated build output.
- Update the relevant design, threat-model, and evaluation documentation when a
  protocol or trust-boundary assumption changes.

By contributing, you agree that your contribution is licensed under the MIT
License in `LICENSE`.
