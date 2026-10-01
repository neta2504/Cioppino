# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Older development snapshots | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting form:

<https://github.com/neta2504/cioppino/security/advisories/new>

Include:

- affected version and operating system;
- a concise description of the impact;
- minimal reproduction steps using synthetic data;
- suggested mitigations, if known.

Do not include real API keys, tokens, private transcripts, databases, personal
filesystem paths, or third-party confidential data. If sensitive evidence is
essential, first describe what evidence is available and wait for a safe exchange
method.

The maintainers will acknowledge a valid report, investigate it, coordinate a fix,
and publish an advisory when appropriate. Response timing depends on severity and
maintainer availability.

## Security boundaries

Cioppino is a local monitoring tool, not a sandbox, endpoint security product, or
complete access-control auditor. It reads supported local agent records, stores
derived data locally, and can terminate a user-selected verified agent process.
Anyone who can access the user's account, browser session, application-data
directory, or local process environment may be able to access Cioppino data.

Release archives are currently unsigned. Verify SHA-256 checksums and obtain
releases only from the official repository.
