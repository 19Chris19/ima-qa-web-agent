# Preserve pre-body session affinity

Forward session profile metadata at session creation, before the first body
event, so durable binding journals retain affinity even if the upstream stream
then fails. Reject local policy changes without penalizing account health.

Verification: synthetic pool/client tests; no real IMA or account data.
Rollout: isolated candidate. Rollback: drain and revert code, retain journals.
