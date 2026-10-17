# FEAT-20261017-IMA-CONTRACT-CATALOG

## User Goal
IMA capability catalog. Implement the approved plan while the existing service stays unchanged.

## Scope
41 operation contracts, offline public-source inspection, scrubbed goldens and CI; catalog cannot authorize runtime operations.

## Verification
Node 22 focused and full tests, package checks and joint synthetic acceptance. Missing paired inputs are reported as skips. No real IMA requests.

## Rollout
Review only. No merge, release, production/client installation, account change, Air action or restart.

## Rollback
Revert the code PR; preserve state, history, credentials and old evidence.
