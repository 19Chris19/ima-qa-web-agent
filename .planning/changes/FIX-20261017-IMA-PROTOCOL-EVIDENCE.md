# FIX-20261017-IMA-PROTOCOL-EVIDENCE

## User Goal
IMA Provider evidence and fresh named identity. Implement the approved plan while the existing service stays unchanged.

## Scope
Exact context/source parity, conservative typed provenance, opt-in memory-only diagnostics, evidence inspector and journaled fresh named applications. Depends on #34.

## Verification
Node 22 focused and full tests, package checks and joint synthetic acceptance. Missing paired inputs are reported as skips. No real IMA requests.

## Rollout
Review only. No merge, release, production/client installation, account change, Air action or restart.

## Rollback
Revert the code PR; preserve state, history, credentials and old evidence.
