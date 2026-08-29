# TrueForge provider investigation setup

Provider investigation uses one persistent TrueForge Coordinator session per
incident. The session is reused for later turns and is reconciled before each
turn. Connection-backed incidents use semantic Coordinator spec `m2.6b-v1`;
legacy incidents retain `m2.5-v1`/`m2.5-v2` behavior.

## 1. Configure the Redrive-owned GitHub MCP endpoint

Run Redrive's production endpoint at:

```text
/api/mcp/github
```

It is a stateless Streamable HTTP JSON endpoint. It exposes only
`get_webhook_delivery`, whose exact input is:

```json
{"connection_id":"<opaque Redrive connection ID>","delivery_id":"<opaque GitHub delivery attempt ID>"}
```

Configure `REDRIVE_GITHUB_CONNECTION_MCP_TOKEN` in the Redrive server
environment. The endpoint requires `Authorization: Bearer <token>` and never puts the token in
an AgentSpec, prompt, event, or error response. Keep the token out of TrueForge
model context. The endpoint must resolve the `ApplicationConnection` again for
each tool call and must reject repository-, hook-, installation-, URL-, token-,
and redelivery-controlled selectors.

In TrueForge Settings, create a configured MCP server for this endpoint. Set
its name to the value used by
`REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME` and point it at the deployed
Redrive endpoint. Keep the existing M2.5 server named by
`REDRIVE_TRUEFORGE_GITHUB_MCP_NAME` separate: it retains the legacy
`hook_id` + `delivery_id` contract and must not point at this strict endpoint.
Configure header authentication for the connection server, for example with
the Settings manifest shape:

```json
{
  "auth": {
    "type": "header",
    "headers": { "Authorization": "Bearer <TrueForge-stored-secret>" }
  }
}
```

The stored value must be the same secret as the Redrive server's
`REDRIVE_GITHUB_CONNECTION_MCP_TOKEN`; do not put the real value in source, an AgentSpec,
or a prompt. The server must expose only `get_webhook_delivery`; no
redelivery or write tool is needed for this milestone.

Do not put the MCP URL or credentials in the Coordinator AgentSpec.

## 2. Register the git-backed Skill

After the reviewed Redrive commit containing both
`skills/redrive-provider-investigation/SKILL.md` and
`skills/redrive-connection-provider-investigation/SKILL.md` is pushed, register
or upsert both manifests in TrueForge Settings. Use the repository's HTTPS URL,
the pushed commit SHA (or a reviewed immutable tag) as `ref`, and these paths:

```json
[
  {
    "manifest": {
      "name": "redrive-provider-investigation",
      "type": "git",
      "url": "https://github.com/Redrive-Labs/Redrive.git",
      "ref": "<reviewed-pushed-commit-sha>",
      "path": "skills/redrive-provider-investigation",
      "description": "Read-only GitHub delivery investigation for a Redrive incident."
    }
  },
  {
    "manifest": {
      "name": "redrive-connection-provider-investigation",
      "type": "git",
      "url": "https://github.com/Redrive-Labs/Redrive.git",
      "ref": "<reviewed-pushed-commit-sha>",
      "path": "skills/redrive-connection-provider-investigation",
      "description": "Read-only connection-backed GitHub delivery investigation for a Redrive incident."
    }
  }
]
```

The exact TrueForge Settings UI or its `settings.skills.createOrUpdate`
operation may be used. Do not register an unreviewed working-tree snapshot.
Skill loading requires the sandbox capability; the Coordinator specs enable the
sandbox with file downloads disabled.

## 3. Configure Redrive's deterministic inputs

Set:

- `REDRIVE_TRUEFORGE_MODEL` to the TrueForge model/resource name;
- `REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME` to the strict connection MCP server name;
- `REDRIVE_TRUEFORGE_GITHUB_MCP_NAME` to the separate legacy hook-based MCP server name;
- `REDRIVE_GITHUB_CONNECTION_MCP_TOKEN` to the server-side bearer token for the strict MCP route;
- `REDRIVE_GITHUB_MCP_TOKEN` only when the legacy bridge itself requires its separate bearer token;
- legacy-only `REDRIVE_GITHUB_HOOK_IDS` (or the single-repository
  `REDRIVE_GITHUB_HOOK_ID`) for incidents without a durable
  `applicationConnectionId`.

A connection-backed investigation never reads the legacy hook mapping and never
falls back to it. Missing or ambiguous deterministic configuration fails
closed before remote session or turn work.

## 4. TrueForge response boundary

The installed `@truefoundry/trueforge-sdk@0.1.4-rc.0` exposes
`tool.response.content` as a string. TrueForge's runtime turns the MCP text
item into one JSON text document. Redrive accepts only that direct JSON
document when it has `full.http_status === 200` and an object at `full.body`;
it does not scrape model messages or accept transcript wrappers. The GitHub
JSON parser preserves unsafe numeric identifiers as opaque strings.

## 5. Validate the canonical trace

With the canonical incident's existing `ACTIVE` binding and immutable provider
snapshot present, call:

```bash
curl -X POST \
  http://localhost:3000/api/incidents/<canonical-incident-id>/provider-investigation
```

For a connection-backed incident, confirm from the response and durable records
that the same TrueForge session was reused, its binding is `m2.6b-v1`, and the
turn produced `thread.created` for `provider-investigator`, exactly one matching
`get_webhook_delivery` MCP call with `connection_id` and `delivery_id`, and its
correlated `tool.response`. Confirm that provider status is `500` and that the
result is `PROVIDER_EVIDENCE_REOBSERVED` when the immutable snapshot matches.

For a legacy incident, confirm the existing m2.5 hook-based trace and version
upgrade behavior remain unchanged.

Do not reset the incident or receiver database, redeliver the delivery, call a
write tool, or deploy the receiver during this validation.
