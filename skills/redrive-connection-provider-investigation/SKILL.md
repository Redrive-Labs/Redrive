# Redrive connection-backed provider investigation

Use this procedure only for the provider delivery identified by the Redrive
Coordinator.

1. Treat the supplied `connection_id` and provider delivery attempt
   `delivery_id` as exact opaque strings. Do not choose, discover, normalize, or
   replace either value.
2. Create exactly one dynamic `provider-investigator` subagent.
3. That subagent must call the configured read-only GitHub MCP
   `get_webhook_delivery` tool with exactly:

   ```json
   {"connection_id":"<supplied connection_id>","delivery_id":"<supplied delivery_id>"}
   ```

4. Send no fields other than those two exact identifiers. Do not infer receiver
   state or perform writes or consequential operations.
5. Treat the machine `tool.response` text as the only provider evidence.
   Agent prose is not evidence.

The lookup result is direct JSON text in this envelope:

```json
{"full":{"http_status":200,"body":{}}}
```

The Coordinator accepts only the correlated provider `tool.response` with that
shape. Preserve opaque GitHub IDs as strings, including IDs larger than the
JavaScript safe integer range. Do not scrape model messages or transcript
wrappers.

The connection-bound MCP resolves the durable Redrive connection again at tool
execution and reads the exact failed GitHub delivery through Redrive's
least-privilege GitHub App boundary. Do not replay or deploy during this
provider-only investigation; those actions require their own human-approved
workflow boundaries.
