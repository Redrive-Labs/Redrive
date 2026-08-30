# Redrive connection-backed receiver investigation

Use this procedure only for the receiver business state identified by the
Redrive Coordinator.

1. Treat the supplied `connection_id` and `delivery_guid` as exact opaque
   strings. Do not choose, discover, normalize, or replace either value.
2. Create exactly one dynamic `receiver-investigator` subagent.
3. That subagent must make exactly one read-only Receiver MCP call:

   ```json
   {"connection_id":"<supplied connection_id>","delivery_guid":"<supplied delivery_guid>"}
   ```

   The tool is exactly:

   ```text
   get_business_state
   ```

4. Do not make a health call. Do not use SQL, database selectors, shell,
   network endpoints, files, repository selectors, connector IDs,
   `receiverConnectionId`, or provider tools. Do not infer provider state.
5. Treat only the correlated machine `tool.response` from
   `get_business_state` as receiver evidence. Agent prose is not evidence.

The Receiver MCP response is direct JSON text for the typed
`business_state:v1` result. Do not accept prose, wrappers, transcript content,
or a response correlated to another thread or tool call.
