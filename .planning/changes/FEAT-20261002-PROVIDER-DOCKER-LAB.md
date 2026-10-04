# Provider A Docker rehearsal

- User goal: validate the published v0.4.0 deployment in isolated Linux containers, without existing accounts or production changes.
- Baseline: v0.4.0 / d12950b03440f4048b9ee1985395e7eed10a9c8e.
- Branch: codex/FEAT-20261002-PROVIDER-DOCKER-LAB.
- Scope: deployment instructions, setup-port correctness and reproducible empty-pool checks.
- Original observation: setup with --host-port 3317 still prints enrolment URL 3117.
- Safety: new synthetic scope and credentials; never import production runtime; no real IMA queries.
- Verification: 259 tests pass; ARM64 original image healthy and pages accessible; AMD64 emulated start succeeds with load-related timeout caveat. Package/image checks pass. See docs/DOCKER_REHEARSAL.md.
- Additional reproduced defect: explicit empty CLI argument becomes boolean true, breaking allowed-origin validation; regression test added and fixed.
- Rollback: retain original image and independent test volumes; no production cutover.
