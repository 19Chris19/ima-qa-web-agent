# DOC-20261004-PROVIDER-AGENT-DEPLOYMENT

- Goal: ship actionable Agent prompts and commands together with onboarding tooling.
- Dependencies: 1e0036a deployment tool and fdd57c2 authorization flow.
- Scope: agent and platform instructions, blank configuration examples, candidate version/compatibility, clean-directory rehearsal and honest acceptance matrix.
- Candidate: v0.4.2, not a published tag or Release. No v0.4.1 tag changes.
- Verification: full synthetic tests, pack audit, Docker build/start and macOS helper rehearsal where available. Windows desktop, maintenance-to-Linux SSH, fresh-account scan and real QA remain NOT RUN until separately performed.
- Rollout: local candidate only. Publishing and any shared service cutover require a later approved window.
- Rollback: revert this documentation/candidate commit before its two dependencies; never restore stale account or conversation data.
