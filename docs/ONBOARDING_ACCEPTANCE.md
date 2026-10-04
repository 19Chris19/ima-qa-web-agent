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
| Container | Candidate build passed; final empty-pool startup check pending | Local-only image, not a published artifact |
| Full regression | 285/285 passed | Synthetic events; no real IMA login |
| Windows desktop | NOT RUN | No Windows maintenance machine supplied |
| Maintenance to Linux over SSH | NOT RUN | No SSH server supplied |
| New account scan / membership / one question and follow-up | NOT RUN | Requires a fresh authorized account and human scan |
| Auth renewal / Linux longevity | NOT RUN | Separate production acceptance |

Do not publish this as an all-platform out-of-box success claim. Credentials, profiles, share-page bodies, answers and runtime logs are excluded from Git. Existing 3117, 3317, 4317 and Bot were not restarted.
