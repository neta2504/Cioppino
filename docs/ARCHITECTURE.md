# Architecture

## Overview

Cioppino is a local TypeScript application with two npm workspaces:

- `backend`: Express server, scanners, SQLite storage, process sampling, and APIs.
- `frontend`: React/Vite single-page dashboard.

The root scripts build, launch, test, and package both workspaces.

## Startup and authentication

`scripts/start.mjs` creates a random token, starts
`backend/dist/server.js`, waits for the loopback listener, and opens
`/auth?t=<token>` in the default browser. The backend validates the token, sets an
HttpOnly SameSite cookie, serves the application, and removes the token from
browser history.

The backend listens on `127.0.0.1` and rejects unexpected Host headers. Authenticated
API responses are marked no-store and served with restrictive browser headers.

## Data flow

Scanners read supported local files and operating-system process information.
Derived records are written to SQLite in the platform application-data directory.
The frontend reads those records through the authenticated local API and receives
performance updates over server-sent events.

Primary areas:

- `backend/src/discovery`: agent registry, installation detection, process identity.
- `backend/src/access`: configuration/access metadata and revoke guidance.
- `backend/src/tokens`: usage parsing and optional local cost estimates.
- `backend/src/activity`: supported transcript import and search.
- `backend/src/downloads`: package/download activity derived from agent records.
- `backend/src/performance`: process and GPU sampling.
- `backend/src/db`: schema, migrations, retention, and complete wipe behavior.
- `frontend/src/pages`: dashboard surfaces.

## Security invariants

- Do not bind the production server beyond loopback.
- Do not accept API requests without the per-launch token.
- Do not log the authentication token.
- Do not copy credential values into access summaries or test fixtures.
- Bound untrusted file reads and parser input sizes.
- Do not execute configuration hooks, MCP servers, extensions, or installers.
- Re-verify supported integration PID identity before process termination.
- Treat imported prompts, responses, paths, and commands as sensitive local data.
- Keep runtime UI assets local.

## Packaging

`scripts/package.mjs` builds both workspaces, creates a minimal runtime package from
the backend dependency manifest, generates a production lockfile, adds
platform-specific launchers, and writes versioned Windows/macOS archives plus
SHA-256 checksums.

`scripts/verify-package.mjs` extracts both archives, checks their contents and
checksums, installs production dependencies in a temporary directory, starts the
current-platform package on a temporary loopback port, and verifies authentication
and security headers.
