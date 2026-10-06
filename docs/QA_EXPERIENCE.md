# Generic QA Experience Candidate

Change-ID: UI-20261006-PROVIDER-QA

Status: local candidate based on 0db3fc2, awaiting parent review/integration.
No production service, credential, backend, admin, vendor or renderer-core changes.

## Behavior

- Main and embed load the same `qa-experience.js` helper before `client.js`.
- Single-line composer: 56px capsule, 28px radius. A measurement-only hidden
  textarea detects wrapping; the interactive textarea is never replaced.
  Multiline text spans the full width above tools, with a 144px height ceiling.
- While generating without a draft, send becomes stop and calls the existing
  AbortController. With a draft, send is unavailable, a separate stop control
  remains reachable and the notice says to stop or wait. Drafts are in-memory
  only: no queue, auto-submit, concurrent turn, or persistence claim.
- Wheel-up, touch, pointer reading and upward keyboard/scroll navigation suspend
  streaming follow. The centered, named return-latest button explicitly resumes
  it. Starting/restoring a conversation also resets follow. Completion does not
  steal focus from the reader or the draft.
- Terminal answers expose a light copy action. Aborted/error/EOF answers expose
  only received partial text; empty failures expose none. History uses the same
  renderer and copy helper. Partial labels honor explicit `complete: false` or
  `interrupted: true` when supplied, without inventing missing history evidence.
- Answer copy is **plain text**, not a Markdown export. It passes only answer
  content and mapped source indexes through the existing safe GFM renderer,
  preserving its citation rules (including literal numbers, code and unmapped
  citations). Block/table separators are retained; source cards, status/error
  text, timers and other metadata are excluded. If the renderer is unavailable,
  received answer text is copied verbatim, matching the display fallback.
- Selection copy accepts a range wholly inside one assistant answer, never user
  messages, sources or mixed selections. The popover has a named button, retains
  selection, supports Tab to focus and Escape to dismiss, and hides on scrolling,
  resizing, outside pointer-down or invalidating answer mutations. Clipboard
  failures expose a read-only selectable textarea, with a close control.
- No external AI call or synthesized process content. The inspected public SSE
  contract exposes conversation/sources/delta/done/error, not structured process
  events. Existing source summaries remain; no inferred upstream process panel.

The website bundle was read only as a behavioral reference for composer sizing,
reading, answer copy and selection copy. No branding, logo, navigation, prompt
bank, queue behavior or animations were ported.

## Verification

- `npm ci --ignore-scripts`: completed; package manifests/lockfile unchanged.
- `node --test test/qa-experience.test.js test/client-answer-flow.test.js test/answer-renderer.test.js`:
  21/21 passed on the final frontend code.
- `npm test -- --test-reporter=dot`: 300/300 passed; final selection-identity
  hardening was subsequently covered by the focused 21-case run.
- Isolated loopback fake HTTP/SSE only, observed in Chromium via Ego Browser:
  desktop main and 390x844 embed; compact dimensions 56px/28px; busy draft
  preservation and partial-copy control; stacked text above tools; no document
  horizontal overflow. Mobile return-latest center measured 195px in a 390px
  panel; compact height/radius also confirmed on mobile. Desktop/mobile
  screenshots were visually inspected outside Git. This is synthetic browser
  evidence, not real QA.
- `python3 scripts/check_governance.py --ci`: attempted, unavailable because this
  independent baseline has no such script. Do not interpret as a passing check.
- `npm audit --omit=dev --json`: reports existing critical `proxy-addr`
  GHSA-jqcg-44mw-7w3h. No dependency update in this frontend-only candidate.

NOT TESTED: real IMA/provider responses, deployed routing/cache behavior,
production cancellation/account release, actual OS clipboard permission flows,
screen-reader announcements, mobile Safari/soft keyboard, persistence of partial
answers by the backend, full browser/platform matrix. No real QA requests were
made. jsdom geometry is synthetic and is not layout proof.

## Integration and Rollback

Parent reviews the named frontend/test/doc files and integrates the commit.
Deploy all public assets together only through the separately approved release
workflow; this change does not deploy anything. Revert the candidate commit to
roll back; no data migration or service mutation is required.
