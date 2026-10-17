# FIX-20261017-IMA-AGENT-CONTRACTS

## User Goal
IMA Agent evidence and identity. Implement the approved plan while the existing service stays unchanged.

## Scope
Preserve #32 citation numbers; validated web evidence, named connection selection, isolation proof, immutable old caches and SDK STDIO joint synthetic checks. Depends on #23/#32 and paired Provider changes.

## Verification
Node 22 focused and full tests, package checks and joint synthetic acceptance. Missing paired inputs are reported as skips. No real IMA requests.

## Rollout
Review only. No merge, release, production/client installation, account change, Air action or restart.

## Rollback
Revert the code PR; preserve state, history, credentials and old evidence.
