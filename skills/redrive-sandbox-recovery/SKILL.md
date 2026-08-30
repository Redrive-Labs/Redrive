# Redrive sandbox recovery

This is a sandbox-only procedure. Never use production credentials, provider
tools, receiver tools, deployment tools, or redelivery tools.

The turn supplies these exact values:

- `repositoryFullName`
- `originalRevision`
- `deliveryGuid`
- `providerStatusCode`
- `receiverMutationCount`

Clone `https://github.com/${repositoryFullName}.git`, checkout the exact
`originalRevision`, and verify:

```text
git rev-parse HEAD == originalRevision
git status --short == empty
```

Prepare the repository deterministically. Install Node >=22.12 if it is
missing, using the official linux-x64 binary after installing `xz-utils` when
needed. Prefer the available local PostgreSQL. Debian PostgreSQL 15 is
acceptable for this reproduction when PostgreSQL 16 is unavailable. Never
use untrusted package keys or bypass package signature verification.

Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm run db:migrate`.
Start the local downstream on port 4000 and receiver on port 3000 with
detached processes that survive the agent command. Confirm both health
endpoints return 200.

Send one reconstructed signed local GitHub push request using the local
development secret `github_webhook_dev_secret` and the supplied delivery GUID.
The reproduction must be exactly:

```text
preCount == 0
HTTP == 500
postCount == 1
```

Capture the downstream 422 reason, and do not send another failing request.

Implement the minimum safe repair. The expected repair class is a downstream
`deliveryId` contract plus database-enforced `external_ref` idempotency using
a unique constraint/index and `INSERT ... ON CONFLICT (external_ref) DO
NOTHING RETURNING ...`, followed by selection of the existing row on
conflict. Do not use in-memory deduplication or check-then-insert logic.

Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
Apply the migration to the same sandbox database containing the one existing
row. Restart the repaired receiver without deleting that database.

Send exactly one sandbox-local redelivery with the same delivery GUID. It must
have `verificationPreCount == 1`, any 2xx HTTP response, and
`verificationPostCount == 1`; the downstream notification must be accepted.

Return only one JSON object with schemaVersion `redrive.recovery.v1`, result
`REPAIR_VERIFIED`, the exact supplied identities, both measurement objects,
non-empty changedFiles, the complete bounded patch including untracked files,
all validation flags true, and the PostgreSQL version. The patch digest is
computed by Redrive; never provide or claim an authoritative digest.
