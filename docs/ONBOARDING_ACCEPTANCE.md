# v0.4.2 onboarding candidate acceptance

Date: 2026-10-04. Source baseline: public main d4eb621. This is a local candidate, not a release.

| Area | Result | Boundary |
|---|---|---|
| Official share metadata | Read-only structure checked | No login, join or QA |
| Deployment core | Synthetic tests passed | Private writes, interrupted resume, foreign-project blocking, image/PW matching |
| Membership flow | Synthetic tests passed | No pool insertion before access; same-window continue, cancellation, unknown/network separation |
| Admin interface | Protected preflight/continue/import tests passed | No real credential captured |
| Shell bootstrap | Syntax and Air doctor passed | Native installed Node used; downloadable bootstrap not exercised |
| macOS helper | Dedicated Chromium installed, repeated install and user LaunchAgent readiness passed | No IMA page opened; isolated helper removed after checks |
| Container to helper | Native ARM64 Playwright connection passed | No page, account, login or question created |
| Container | Native ARM64 build and network-disabled empty-pool startup passed | Local-only image, not a published artifact |
| Full regression | 288/288 passed; production audit 0 | Synthetic events; no real IMA login |
| Login-gated metadata | Synthetic login, timeout, context cleanup and manifest tests passed | Authenticated real share resolution NOT RUN |
| Clean source | Fixed-source extraction, npm ci and Shell doctor passed | Node download fallback NOT RUN; existing Node 22 used |
| Windows desktop | NOT RUN | No Windows maintenance machine supplied |
| Maintenance to Linux over SSH | NOT RUN | No SSH server supplied |
| New account scan / membership / one question and follow-up | NOT RUN | Requires a fresh authorized account and human scan |
| Auth renewal / Linux longevity | NOT RUN | Separate production acceptance |

Do not publish this as an all-platform out-of-box success claim. Credentials, profiles, share-page bodies, answers and runtime logs are excluded from Git. Existing 3117, 3317, 4317 and Bot were not restarted.

## Fixed artifacts and handoff

- Verified Provider code: `76cd647acc9c57bf6aaf92039884893c2a498369`; local ARM64 image ID `sha256:b9355564ec204099151e3447f422a3973b0da36802fbe2a4e630f9730a874a00`. This is not a GHCR release digest.
- Verified with website code `2ae76caff3f89c2ce658654065a4345beb763890` through its clean-directory double-service entry: first install, resume with unchanged private configuration, blocked repeated init, empty capacity and protected enrollment preflight.
- Temporary helper was uninstalled and rehearsal services stopped. Private scratch configuration and empty rehearsal volumes remain local, excluded from Git; no existing service data was copied.
- An earlier cold start exceeded the original helper wait; safe retry succeeded. Final code uses a bounded 30-second wait and the final fresh install passed.
- Tests/builds cover ARM64 only in this candidate. AMD64 execution, native Windows, SSH-to-Linux, new authorized-account scan, real QA and longevity are still separate release gates.

Feature refs are retained: guided deploy (`1e0036a`), membership (`fdd57c2`), readiness fix (`5b3e81a`), Agent docs (`20b3785`), installation follow-up (`76cd647`). They form a linear dependency chain; the local `codex/REL-20261004-PROVIDER-V042` includes them without rewriting history. Revert the follow-up/docs/readiness before removing membership or deployment support. Do not reset branches or overwrite current runtime data.
