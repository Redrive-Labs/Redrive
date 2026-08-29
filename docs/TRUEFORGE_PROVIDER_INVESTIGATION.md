# TrueForge provider investigation setup

Provider investigation uses one persistent TrueForge Coordinator session per
connection-backed incident. The session is reused for later turns and is
reconciled before each turn with semantic Coordinator spec `m2.6b-v1`.

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
Redrive endpoint. Configure header authentication for the connection server, for example with
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

After the reviewed Redrive commit containing
`skills/redrive-connection-provider-investigation/SKILL.md` is pushed, register
or upsert its manifest in TrueForge Settings. Use the repository's HTTPS URL,
the pushed commit SHA (or a reviewed immutable tag) as `ref`, and this path:

```json
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
```

The exact TrueForge Settings UI or its `settings.skills.createOrUpdate`
operation may be used. Do not register an unreviewed working-tree snapshot.
Skill loading requires the sandbox capability; the Coordinator spec enables the
sandbox with file downloads disabled.

## 3. Configure Redrive's deterministic inputs

Set:

- `REDRIVE_TRUEFORGE_MODEL` to the TrueForge model/resource name;
- `REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME` to the strict connection MCP server name;
- `REDRIVE_GITHUB_CONNECTION_MCP_TOKEN` to the server-side bearer token for the strict MCP route.

Missing deterministic configuration fails closed before remote session or turn
work. The connection and delivery identifiers come from durable incident state.

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

Do not reset the incident or receiver database, redeliver the delivery, call a
write tool, or deploy the receiver during this validation.
