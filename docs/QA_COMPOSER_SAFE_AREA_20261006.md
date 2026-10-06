# Public Provider QA safe-area candidate

Base: `ad62b69e45f3d8298003217e48a1a700fd987f1a`.
Adapted from Air UI commit `5a01e6ca2eea8840032d58a0cc04153f3e57c65d`.
Change: `UI-20261006-PUBLIC-QA-SAFE-AREA`. Status: **Not deployed**.

## Adaptation scope

Compared public index/embed/CSS before editing. Public already used a normal-flow
notice and has a separate draft-stop button, unlike Air. Preserve that button,
all existing input/status nodes, public branding and public client behavior.
Only viewport metadata and focused CSS rules changed; no backend or JavaScript
was imported. Notice now occupies its own grid row below the form, with its
actual height plus bottom safe-area padding reserved. Short landscape no longer
inherits the 560px workspace minimum. QA targets have minimum dimensions 44px;
SVG glyphs remain 18/22px. Draft-stop inherits the 44px minimum as well.

## Automated tests

Both new index/embed layout tests failed before implementation (the explicit
white-space/grid contract was absent), then passed. JSDOM checks CSS contracts,
not actual layout. It preserves public's two form buttons rather than imposing
Air's single-button assertion.

Executed in this candidate worktree with
`PROVIDER_ADMIN_CONTRACT_ROOT` set to this worktree's absolute root:

```sh
PROVIDER_ADMIN_CONTRACT_ROOT="$PWD" node --test test/qa-composer-layout.test.js test/qa-experience.test.js test/answer-renderer.test.js test/client-answer-flow.test.js
PROVIDER_ADMIN_CONTRACT_ROOT="$PWD" npm test
```

Focused: **29/29 passed**. Full public suite: **472/472 passed**, no skips.
`npm ci --ignore-scripts` installed unchanged locked dependencies; audit reported
zero vulnerabilities. No dependency or lockfile changes.

## Independent synthetic browser evidence

Ego Browser used one local HTTP fixture on an ephemeral loopback port. Both `/`
and `/embed.html` served only allowlisted assets from this public candidate's
single `public/` directory, with the same `client.js`, CSS, renderer and vendor
assets. No Air asset fallback, Provider backend imports, live config, account
data or IMA requests. Synthetic SSE emits a table/paragraph fixture then one
paragraph every 800ms for up to approximately 96 seconds.

Each case entered a two-line draft during output, waited for wheel motion to
settle after scrolling up, observed more text without scrollTop movement, clicked
latest, observed further output at the bottom, then stopped using public's
draft-stop button. Original input/send objects and draft were preserved.

| Page | Viewport | Notice bottom | Held scrollTop | Follow bottom gap |
| --- | --- | ---: | ---: | ---: |
| Main | 390x844 | 832 | 644.5 | -0.5 |
| Main | 360x800 | 788 | 699 | -1 |
| Main | 844x390 | 349 | 1134 | -1 |
| Embed | 390x844 | 832 | 470.5 | -0.5 |
| Embed | 360x800 | 788 | 610 | 0 |
| Embed | 844x390 | 374 | 643 | 0 |

All six cases passed: no document overflow, positive chat height, notice below
form and inside viewport, send/draft-stop/latest 44x44, mobile sidebar 44x44,
send glyph 22x22. Landscape hides the sidebar toggle. Negative fractional bottom
gaps are browser scroll rounding within one pixel. Screenshots visually checked
for main 360, embed 390 and embed landscape.

Ephemeral local evidence: `/tmp/public-qa-safe-area.qTUQ2P/` contains fixture
`server.cjs`, Ego runner `check.mjs`, six-case `geometry.json`, twelve viewport
screenshots (`*-held.png`, `*-follow.png`) and `full-test.log`. These are synthetic
test evidence, not runtime or deployment inputs.

## Limits and rollback

Not physical-device acceptance: soft keyboards, nonzero hardware safe-area
insets, touch gestures, extreme zoom and arbitrary translated notices remain
unverified. CSS viewport/safe-area support does not establish those results.
No live service, deployment, push or merge occurred. Rollback is reverting this
UI commit only, never restoring account/runtime data.

The standalone repository has no `scripts/check_governance.py`; the installed
governance skill checker was used with `--repo` and `--ci`. It reports zero hard
blocks with existing initialization/ownership/upstream warnings. No checker or
unrelated governance baseline was changed.
