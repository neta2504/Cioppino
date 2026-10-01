# Changelog

All notable changes to Cioppino will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-01

### Added

- Open-source project documentation and GitHub community configuration.
- Complete supported-agent capability matrix in the project README.
- Reproducible Windows and macOS Node.js release bundles with checksums.
- CI, dependency updates, security scanning, and package verification.

### Security

- Prevented authentication-token disclosure in launcher output.
- Removed third-party runtime font requests.
- Replaced generic shell-based version probes with bounded argument-based probes.
- Added browser security headers and no-store API responses.
- Made local data wiping transactional and complete across application tables.

Initial public release of the local-first AI agent activity monitor.

[Unreleased]: https://github.com/neta2504/cioppino/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/neta2504/cioppino/releases/tag/v0.1.0
