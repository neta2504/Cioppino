# Contributing to Cioppino

Thank you for helping improve Cioppino.

## Before you start

- Search existing issues and pull requests.
- Use synthetic fixtures. Never submit real credentials, transcripts, databases,
  user paths, or confidential third-party data.
- Keep changes focused. Do not redesign the application when a smaller correction
  solves the problem.
- Discuss broad architectural changes in an issue first.

## Development setup

Requirements:

- Node.js 24 or newer
- npm 11 or newer
- Windows or macOS for supported-platform verification

```powershell
npm ci
npm run build
npm run test:backend
```

For frontend development, run the backend and frontend in separate terminals:

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

## Testing

Run the smallest relevant test while developing, then run the complete validation
before opening a pull request:

```powershell
npm test
npm audit
npm run package
npm run verify:package
```

Browser tests use Playwright Chromium. On Windows, an installed Edge browser can
be selected with `CIOPPINO_TEST_BROWSER=msedge`.

Tests that inspect agent data must use temporary directories and synthetic records.
They must not read the contributor's real transcripts or Cioppino database.

## Pull requests

- Explain the user-visible behavior and why the change is needed.
- Add tests for fixes and new behavior.
- Update directly related documentation.
- Call out privacy, security, data migration, process-control, and platform effects.
- Keep generated build output, databases, logs, and package archives out of commits.

By contributing, you agree that your contribution is licensed under the MIT
License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
