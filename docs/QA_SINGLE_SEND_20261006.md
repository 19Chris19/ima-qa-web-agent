# Public QA single send/stop candidate

Base: `014b93c7c168e9affc5da1fdfe0054e057763fda`.
Change: `UI-20261006-PUBLIC-QA-SINGLE-SEND`. Status: **Not deployed**.

## Contract

The existing primary button is stop throughout generation, including when an
editable draft is present. Clicking it aborts the current request and retains
the draft. Busy Enter does not submit, enqueue or abort. Terminal completion or
interruption restores send; a retained draft requires an explicit subsequent
submission. No queue or automatic next request was added.

Only the redundant draft-stop node in main/embed, its CSS/binding and the small
composer state/submit branch changed. Public API requests, embed client identity,
branding, backend and BFF remain unchanged. Existing primary input/button nodes,
safe-area layout and 44px targets remain in place. This supersedes the previous
safe-area report's deliberate preservation of the separate draft-stop button.

## Verification

Before implementation, six index/embed assertions failed: two form-button counts
and four busy-draft stop-label expectations. After implementation, focused layout,
QA experience, renderer and answer-flow tests passed **31/31** with
`PROVIDER_ADMIN_CONTRACT_ROOT` pointing at this worktree. Tests cover stop with
partial output, draft/node preservation, no busy-Enter abort or duplicate request,
completion restoring send, and explicit next submission in both pages.

Full public suite with the same contract-root setting: **474/474 passed**, no
skips. Dependencies installed with `npm ci --ignore-scripts`; no lockfile change.

Ego Browser main and embed each passed 390x844, 360x800 and 844x390 synthetic
slow-SSE checks. Both pages loaded the same candidate worktree public assets
from one loopback fixture; no Air/backend fallback. Stream cadence was 800ms,
with a maximum duration approximately 96 seconds. Each case verified one form
button, busy Enter leaving request count at one, the primary still labeled stop,
editable retained draft, continued output while manually scrolled up, explicit
latest restoring follow, and primary stop restoring send without a second ask.
Original input/send nodes remained identical. Notice stayed in viewport; send
and latest remained 44px, send glyph 22px, and no document overflow occurred.

| Page | Viewport | Held scrollTop | Follow bottom gap |
| --- | --- | ---: | ---: |
| Main | 390x844 | 704 | 0 |
| Main | 360x800 | 615.5 | -0.5 |
| Main | 844x390 | 1034.5 | -0.5 |
| Embed | 390x844 | 554 | -0.5 |
| Embed | 360x800 | 610 | 0 |
| Embed | 844x390 | 643 | 0 |

Browser runs deliberately stopped the stream; natural completion and explicit
next-submit behavior are covered by deterministic main/embed JSDOM tests, not
claimed as natural-completion browser evidence. Main 360 and embed 390 screenshots
were visually inspected. Local synthetic evidence is in
`/tmp/public-qa-single-send.cbnvsT/`: fixture/runner, `geometry.json`, twelve
held/follow screenshots, `focused.log`, and `full-test.log`. Red-test output is
`/tmp/public-single-send-red.log`.

Ownership and diff checks passed. The installed governance skill checker
(`--repo ... --ci`, because this standalone repository has no local checker)
reported zero hard blocks; existing initialization/ownership/upstream and old
change-record warnings were not broadened into this UI patch.

## Boundaries

Synthetic fixtures only; no live service/configuration, real accounts or IMA
requests. No push, merge or deployment. Viewport emulation is not physical-device
acceptance: real soft keyboards, touch gestures and nonzero hardware safe-area
insets remain unverified. Rollback is reverting this commit to the base's
dual-button behavior, without restoring account/runtime state.
