# TrueForge provider-investigation setup

M2.5B incident execution does not create or mutate TrueForge connectors. The
following resources must be provisioned once by an operator.

## 1. Configure the read-only GitHub MCP server

In TrueForge Settings, create one configured MCP server. Set its name to the
value used by `REDRIVE_TRUEFORGE_GITHUB_MCP_NAME`. Point it at the already
proven Redrive GitHub MCP bridge and keep its credentials in TrueForge
Settings. The bridge must expose `get_webhook_delivery`; no redelivery or write
tool is needed for this milestone.

Do not put the MCP URL or credentials in the Coordinator AgentSpec.

## 2. Register the git-backed Skill

After the reviewed Redrive commit containing
`skills/redrive-provider-investigation/SKILL.md` is pushed, register or
upsert this manifest in TrueForge Settings. Use the repository's HTTPS URL, the
pushed commit SHA (or a reviewed immutable tag) as `ref`, and this path:

```json
{
  "manifest": {
    "name": "redrive-provider-investigation",
    "type": "git",
    "url": "https://github.com/Redrive-Labs/Redrive.git",
    "ref": "<reviewed-pushed-commit-sha>",
    "path": "skills/redrive-provider-investigation",
    "description": "Read-only GitHub delivery investigation for a Redrive incident."
  }
}
```

The exact TrueForge Settings UI or its `settings.skills.createOrUpdate`
operation may be used. Do not register an unreviewed working-tree snapshot.
Skill loading requires the sandbox capability; the Coordinator v2 spec enables
the sandbox with file downloads disabled.

## TrueForge response boundary

The installed `@truefoundry/trueforge-sdk@0.1.4-rc.0` exposes
`tool.response.content` as a string. TrueForge's runtime turns an MCP text item
(or structured result) into one JSON text document. Coordinator v2 disables
TrueForge's default large-tool-response offload because an offloaded sandbox
preview is not an authoritative delivery result. Redrive accepts only that
direct JSON document when it has `full.http_status === 200` and an object at
`full.body`; it does not scrape model messages or accept transcript wrappers.
The existing GitHub MCP JSON parser is reused so an unsafe numeric
`full.body.id` remains an opaque string.

## 3. Configure Redrive's deterministic inputs

Set:

- `REDRIVE_TRUEFORGE_MODEL` to the TrueForge model/resource name;
- `REDRIVE_TRUEFORGE_GITHUB_MCP_NAME` to the configured MCP server name;
- `REDRIVE_GITHUB_HOOK_IDS` (or the single-repository
  `REDRIVE_GITHUB_HOOK_ID`) to an explicit repository-to-hook mapping.

The recovery route fails closed when any of these values is missing. It never
derives a hook ID from a repository ID.

`coordinator_spec_version` records the repository-owned semantic Redrive
Coordinator spec version. Before each investigation turn, Redrive reconciles
the current runtime model and GitHub MCP resource selection onto the same
ACTIVE inline session; it does not create a replacement session.

## 4. Validate the canonical trace

With the canonical incident's existing `ACTIVE` binding and immutable provider
snapshot present, call:

```bash
curl -X POST \
  http://localhost:3000/api/incidents/<canonical-incident-id>/provider-investigation
```

Confirm from the response and durable records that the same TrueForge session
was reused, its binding changed from `m2.5-v1` to `m2.5-v2`, and the turn
produced `thread.created` for `provider-investigator`, a matching
`get_webhook_delivery` MCP call, and its correlated `tool.response`. Confirm
that provider status is `500` and that the result is
`PROVIDER_EVIDENCE_REOBSERVED`.

Do not reset the incident or receiver database, redeliver the delivery, call a
write tool, or deploy the receiver during this validation.
