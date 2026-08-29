# Redrive provider investigation

Use this procedure only for the provider delivery identified by the Redrive
Coordinator.

## Legacy incidents (M2.5 compatibility)

For an incident without a durable `applicationConnectionId`, retain the
existing explicit repository-to-hook configuration. Use only the supplied
incident ID, repository ID, `hook_id`, and provider delivery attempt
`delivery_id` with the legacy bridge. Do not use this compatibility path for a
connection-backed incident, and do not fall back from a connection lookup to
legacy hook configuration.

## Evidence boundary

The lookup result is direct JSON text in this envelope:

```json
{"full":{"http_status":200,"body":{}}}
```

The Coordinator accepts only the correlated provider `tool.response` with that
shape. Preserve opaque GitHub IDs as strings, including IDs larger than the
JavaScript safe integer range. Do not scrape model messages or transcript
wrappers.

Provider delivery attempt ID (`delivery_id`) and logical delivery GUID
(`X-GitHub-Delivery`) are different identities. The logical GUID is established
only by the provider lookup result.

Do not redeliver, deploy, or call a write/consequential tool during provider
investigation. Later deployment and redelivery require their own human-approved
workflow boundaries.
