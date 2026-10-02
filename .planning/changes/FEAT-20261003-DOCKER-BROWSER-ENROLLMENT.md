# Docker enrollment through a local maintenance browser

- Goal: keep the admin-page add-account workflow while Docker owns account storage.
- Scope: optional private Playwright browser endpoint; existing enrollment manager still owns identity checks, verification and encrypted persistence.
- Security: helper binds loopback, uses a random 256-bit path, launches its own browser and creates a new context for every enrollment. Endpoint errors are redacted. No daily browser or existing account store is reused.
- Deployment: helper and container must use the same Playwright version. Private helper configuration and endpoint are never committed. Loopback forwarding through Docker Desktop must be verified before enabling this route.
- Verification: endpoint validation, fresh context cleanup and error redaction tests; browser opening and cancellation smoke test. Actual account success requires user scan and subsequent verification.
- Rollback: unset IMA_ENROLLMENT_BROWSER_ENDPOINT, restore prior container image, stop only the dedicated helper. Do not replace account or session volumes.
- Limitation: this helper is for a local Docker Desktop maintenance machine, not an unauthenticated remote browser service. Do not expose its port or token to a public network.
