# Trusted Application Identity

Provider can bind ordinary and internal credentials to maintainer-chosen stable
application IDs. This is a server-side deployment configuration, never a browser
registration API. Pair this change with the durable executor's `applicationKey`
forwarding before enabling mappings.

## Configuration

Set `IMA_QA_APPLICATIONS_JSON` in private deployment configuration. For embedding,
the equivalent is `config.security.applications`. Example values below are
synthetic placeholders, not usable credentials:

```json
[
  {
    "id": "website-east",
    "apiTokens": ["REPLACE_WITH_EAST_ORDINARY_TOKEN"],
    "internalServiceTokens": ["REPLACE_WITH_EAST_SERVICE_TOKEN"]
  },
  {
    "id": "website-west",
    "apiTokens": ["REPLACE_WITH_WEST_ORDINARY_TOKEN"],
    "internalServiceTokens": ["REPLACE_WITH_WEST_SERVICE_TOKEN"]
  }
]
```

IDs start with a lowercase letter and contain only lowercase letters, digits,
underscore and hyphen, at most 64 characters. There may be at most 64 applications,
each with at most eight tokens per credential type. An omitted token array is
empty; an application must have at least one credential. Tokens are nonempty
printable ASCII without whitespace, at most 4096 characters. Unknown fields,
duplicate IDs, repeated tokens (including across credential types/applications),
or overlap with the existing single-token settings fail startup. Malformed JSON
also fails startup. Errors never include token values.

Ordinary mapped tokens authorize ordinary APIs, not internal APIs. Internal
mapped tokens authorize the existing internal APIs, not ordinary APIs. For a BFF
that creates ordinary conversations then submits internal tasks, provision both
credential types under the **same application ID**. An internal-only credential
does not grant a new ordinary conversation-creation privilege.

The existing `IMA_QA_API_TOKEN` and `IMA_QA_INTERNAL_SERVICE_TOKEN` remain supported
as separate legacy credentials. They must not also appear in the mapping. A blank
ordinary legacy token still permits the existing tokenless builtin for local-only
use, even when mapped credentials exist. Configure a nonempty legacy ordinary
token when exposing a secured service; the mapping alone does not disable the
local-demo policy. With mappings present, an unknown/malformed/revoked bearer
fails 401 instead of falling back to tokenless identity. Internal routes return
404 only when neither a legacy nor any mapped internal credential is configured.

Never put service/ordinary credentials in browser JavaScript, checked-in JSON,
examples, logs or health output. The secured bundled UI still requires an
authenticated proxy/client. Do not proxy internal routes publicly.

## Identity and Isolation

Authenticated middleware selects `application:<id>`. Arbitrary application
headers/body fields are ignored; they cannot choose a scheduler group or owner.
The existing browser client ID/cookie still identifies a visitor, but mapped
visitors become an application-qualified owner in private stores. The prefix uses
characters forbidden in a raw client ID, preventing tokenless or legacy callers
from forging it. These owner keys are not sent to clients.

The same application may access its conversations with either its ordinary or
internal credential where that route permits the credential type. Different
applications cannot read/delete those conversations, use their upstream sessions,
read/cancel/replay their tasks or collide with their idempotency keys, even if
they supply the same visitor ID and request key. Ordinary/internal task scopes
remain separate within an application. Legacy deep-ask idempotency is isolated by
the same qualified owner. Public task request-key hashes retain their existing
format, but their lookup remains application/owner/scope-bound.

Mapped applications enter separate scheduler groups with visitor/conversation
keys underneath. Legacy ordinary and internal credentials retain stable groups
`ordinary` and `internal`; legacy asks now supply those trusted groups too rather
than all using an implicit `legacy` group. The old single-credential owner space
is retained for compatibility, including legacy ordinary/internal conversation
sharing. Tokenless builtin shares that old ordinary owner space. These legacy
modes cannot distinguish deployments sharing one credential; independent fairness
requires separately configured application IDs. Multiple credentials under the
same ID intentionally share identity and fairness allocation. Scheduler fairness
is admission order among runnable work, not a latency or account-slot guarantee.

## Rotation and Recovery

To rotate a credential, add the replacement to the same ID/type, reload Provider,
switch clients, then remove the old token and reload. Both tokens temporarily
resolve to the same owner and idempotency namespace. Application IDs must remain
stable: do not rename or reuse one for a different deployment. Removing an ID
does not erase its private tasks or history.

New task records retain `applicationKey` independently of tokens. Old v1 task
records lacking this field are atomically assigned their original `scope`
(`ordinary` or `internal`) while the exclusive writer lock is held. Migration
does not rewrite owner, input fingerprint, key hash, event sequence, terminal
state or history receipt. Existing recovery still resumes only queued tasks;
dispatched running tasks become indeterminate and completed journals remain
idempotent. Terminal/event-expired receipts keep their identity and cannot re-ask
an old key after migration. A migration write failure disables the task store.

This is not an automatic legacy-history reassignment to a named application.
Moving a legacy token into a newly named mapping changes its namespace and does
not grant access to old legacy conversations. Retain legacy access for old work;
onboard named deployments with new conversations. Never delete receipts to work
around a migration or identity error.

## Integration and Tests

- `req.applicationKey` is set by trusted authentication middleware.
- `tasks.submit` receives `applicationKey`; `tasks.cancel` receives it as argument four.
- `store.create` accepts the object field. `find`, `owned`, `list` accept a trailing
  optional applicationKey (legacy default is scope). The key participates in
  receipt lookup and ownership checks, not the content fingerprint.
- The companion executor passes applicationKey through admission/persistence and
  uses `task.applicationKey || task.scope` for scheduler keys. Pool reservation
  and executor implementation are separate changes.

```sh
node --test test/application-identity.test.js test/config.test.js test/app.test.js test/durable-qa-tasks.test.js
# After the companion executor is integrated, enable the full task HTTP check:
PROVIDER_IDENTITY_INTEGRATION=1 node --test test/application-identity.test.js
```

All fixtures use synthetic credentials and loopback HTTP. They cover mapping
validation, credential rotation, header spoofing, owner/task/idempotency isolation,
legacy recovery and trusted legacy/durable scheduler keys. No real IMA call is
needed or permitted by this workflow.
