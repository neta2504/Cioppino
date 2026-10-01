# Privacy

Cioppino is designed as a local-first activity monitor. It does not require an
account and does not send telemetry to a Cioppino-operated service.

## Data Cioppino reads

Depending on which agents are installed and which integrations are supported,
Cioppino may read:

- agent installation and process metadata;
- agent configuration files and MCP/extension declarations;
- local session, transcript, usage, error, latency, and command records;
- project paths and repository metadata recorded by agents;
- operating-system process and resource information.

Readers are intended to inspect files without modifying the source agent
configuration or transcript. Some supported formats contain prompts, responses,
commands, URLs, project names, and filesystem paths. Treat all imported activity
as potentially sensitive.

Cioppino's access summaries report the presence and names of credential-related
settings. Newer bounded integration readers deliberately exclude credential
values, command arguments, HTTP headers, and configured URLs. No detection rule
can guarantee that every unsupported or future format is free of sensitive data.

## Data Cioppino stores

Derived data is stored in `cioppino.db`:

- Windows: `%APPDATA%\Cioppino\cioppino.db`
- macOS: `~/Library/Application Support/Cioppino/cioppino.db`

The database may contain imported activity text, previews, token counts, project
paths, download commands, agent paths, configuration paths, and performance
samples.

Use **Settings > Wipe all data** to clear every Cioppino application table.
Wiping Cioppino does not remove the original agent files. You can also stop
Cioppino and delete its application-data directory.

## Network behavior

The application server binds to `127.0.0.1`. Normal runtime UI assets are served
locally and do not load third-party fonts, analytics, or telemetry.

Network access can still occur when:

- the first release-bundle launch runs `npm ci` against the npm registry;
- you click an external help, source, or credential-revocation link;
- an installed agent executable performs its own behavior when Cioppino invokes
  a bounded `--version` probe. Windows batch and command shims are not executed
  for generic version probing.

Cioppino does not control the network behavior of installed agents or your web
browser after an external link is opened.

## Local API protection

Cioppino uses a random token for each launch, an HttpOnly SameSite cookie, a
loopback Host allow-list, restrictive browser headers, and no-store API responses.
The token is placed in the initial local authentication URL so the browser can
bootstrap the session, then removed from browser history.

## Diagnostics and bug reports

Do not attach your database, real transcripts, environment files, credential
files, screenshots containing private paths, or unredacted logs to a public issue.
Use synthetic fixtures and redact usernames, project names, tokens, URLs, and
filesystem paths.
