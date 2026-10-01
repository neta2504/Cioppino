# Releasing Cioppino

This document describes the owner steps for publishing a release. The local
repository preparation does not create or push a GitHub repository.

## Prerequisites

- Node.js 24 and npm 11.
- A clean `main` branch.
- Branch protection and required CI checks configured.
- CodeQL required when code scanning is available for the repository.

## Prepare

1. Update the version consistently in the root and workspace package manifests.
2. Move relevant entries from `Unreleased` to a dated changelog section.
3. Run:

   ```powershell
   npm ci
   npm test
   npm audit
   npm run package
   npm run verify:package
   ```

4. Inspect `release/SHA256SUMS.txt`.
5. Extract and smoke-test the Windows ZIP on Windows.
6. Verify the macOS tarball on a native macOS GitHub Actions runner. Complete a
   manual macOS smoke test before making the repository public.
7. Confirm Settings > Wipe all data removes all indexed content.
8. Confirm no credentials, private paths, databases, logs, or generated dependency
   directories are committed or packaged.

## Publish the repository

Create the private repository as `neta2504/Cioppino`, then:

```powershell
git remote add origin https://github.com/neta2504/cioppino.git
git push -u origin main
```

Enable:

- Dependabot alerts and security updates;
- secret scanning and push protection, when available;
- branch protection requiring CI and, when available, CodeQL.

Keep the repository private until public release readiness is approved
separately. Enable private vulnerability reporting when the repository becomes
public.

## Publish a release

Create and push an annotated version tag:

```powershell
git tag -a v0.1.0 -m "Cioppino v0.1.0"
git push origin v0.1.0
```

The release workflow builds and verifies artifacts and creates a draft GitHub
Release. Review the generated archives, checksums, changelog text, and smoke-test
results before publishing the draft.

Artifacts are unsigned. Do not claim code signing or notarization until those
controls are implemented and verified.
