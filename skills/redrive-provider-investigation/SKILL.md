# Redrive provider investigation

Use this procedure only for the provider delivery identified by the Redrive
Coordinator.

1. Treat the provider delivery attempt ID (`delivery_id`) and the logical
   delivery GUID (`X-GitHub-Delivery`) as different identities.
2. Use only the incident ID, repository ID, hook ID, and provider delivery
   attempt ID supplied by Redrive. Do not choose or discover identifiers.
3. Perform a read-only lookup with `get_webhook_delivery` using the supplied
   `hook_id` and `delivery_id`.
4. Do not infer receiver state or claim provider facts from prose.
5. Do not redeliver the delivery or call a write/consequential tool.
6. If the lookup cannot establish a fact, report the uncertainty explicitly.

The lookup result is the provider evidence input. The Coordinator, not a model
message, decides whether that machine-observed result can be accepted.
