# Generic QA Experience Candidate

Change-ID: FEAT-20261009-PROVIDER-TASK-UI (extends UI-20261006-PROVIDER-QA)

Status: durable-task frontend candidate based on dc96655, awaiting parent integration.
No production service, credential, backend, admin, vendor or renderer-core changes.

## Behavior

- Main and embed load the same `qa-experience.js` and `qa-tasks.js` helpers before `client.js`.
- Single-line composer: 56px capsule, 28px radius. A measurement-only hidden
  textarea detects wrapping; the interactive textarea is never replaced.
  Multiline text spans the full width above tools, with a 144px height ceiling.
- While generating, the single primary send control remains stop, with or without
  a draft. IMA stop explicitly deletes the current task; non-IMA stop retains the
  existing AbortController behavior. There is no extra stop button.
  A layout-neutral notice asks the user to stop or wait before sending a draft.
  On completion the primary control returns to send. Empty submissions do not
  dispatch a request; the current primary control remains enabled. Drafts are
  preserved and are in-memory
  only: no queue, auto-submit, concurrent turn, or persistence claim.
- Wheel-up, touch, pointer reading and upward keyboard/scroll navigation suspend
  streaming follow. The centered, named return-latest button explicitly resumes
  it. Starting/restoring a conversation also resets follow. Completion does not
  steal focus from the reader or the draft.
- Terminal answers expose a light copy action. Cancelled/failed/indeterminate
  answers expose only received partial text; empty failures expose none. IMA
  EOF reconnects to the task, not a terminal failure. History uses the same
  renderer and copy helper. Partial labels honor explicit `complete: false` or
  `interrupted: true` when supplied, without inventing missing history evidence.
- Answer copy preserves **original Markdown**, including tables, code fences and
  whitespace. It ports the website's parser-token-boundary copy rule, removing
  only prose/context-ref citations mapped by structured source indexes. Code,
  escaped literals, ordinary links, bare numbers and unmapped citations remain.
  Source cards, status/error text, timers and other metadata are excluded. With
  no source mapping or parser, received Markdown is copied verbatim.
- Successful copy feedback resets after 1.5 seconds; copying again restarts the
  timer. Selection copy remains only the selected plain text, not Markdown.
- Selection copy accepts a range wholly inside one assistant answer, never user
  messages, sources or mixed selections. The popover has a named button, retains
  selection, supports Tab to focus and Escape to dismiss, and hides on scrolling,
  resizing, outside pointer-down or invalidating answer mutations. Clipboard
  failures expose a read-only selectable textarea, with a close control.
- No external AI call or synthesized process content. Task SSE process text,
  when supplied by the backend, appears as escaped text outside the answer and
  copy content; it disappears on completion. Task status supplies queued/running
  indicators. No inferred upstream process stages.

## Durable Task Contract

- Only explicitly declared `openapi-mimo` and `local-rag-mimo` providers retain
  legacy `/api/ask`. Native IMA requires ordinary-auth `/api/capabilities` with
  `features.durable_qa_tasks_v1: true`. Missing/failed capability means visibly
  unavailable, never an implicit legacy fallback. No internal route or service
  token is used. Existing browser owner cookies and embed `X-IMA-Client-Id`
  headers are reused for every task request.
- An explicit send creates an ordinary conversation first if needed, then makes
  exactly one `POST /api/tasks` with `{question, conversationId}` and a
  `crypto.randomUUID()` Idempotency-Key. Only task/conversation IDs and the
  SHA-256 request correlation hash are saved locally, never answers or drafts.
  Lost acknowledgements use owner-scoped GET list `requestKey` lookup. Unknown
  submissions stay blocked for manual recovery; they are never automatically
  posted again, with either the old or a new key.
- `GET /api/tasks/:id` replays the snapshot and SSE `/:id/events?after=N` resumes
  strictly after the last applied integer sequence. Repeated events are ignored;
  a sequence gap triggers GET recovery before later text is accepted. Rotation,
  network errors and EOF reconnect only to that same task. No-progress retries
  wait 1/2/4/8/8 seconds, then expose a reconnect command. Progress resets the
  retry budget; a healthy long-running task has no total UI deadline.
- The single stop control calls DELETE only after an explicit click. Lost stop
  acknowledgement is not reported as successful cancellation. GET confirms the
  terminal outcome; cancelled/failed/indeterminate never cause another POST.
- New conversation and history selection detach the old subscription without
  cancelling its task. Navigation epochs fence late callbacks. Refresh reads
  history and owner-scoped task list; active work restores its snapshot and
  question (when provided), without resending. A saved completed task or an
  `eventsExpired` terminal task reloads and replaces history, never appending a
  second answer. Failed tasks retain replayable partial text rather than losing
  it to success-only history. Missing history is an explicit recoverable error.
- Capability/restore failures prevent accidental sends. Task errors and recovery
  notices stay separate from raw Markdown; draft retention, source mapping,
  selection copy and original table/code/whitespace rules remain unchanged.

## Current Verification

Synthetic jsdom regression suite covers task submit, owner headers, explicit
cancel, ambiguous POST recovery, EOF/network retry bounds, cursor dedup/gaps,
refresh with active/terminal/expired tasks, detached navigation, failure partial
copy, process escaping, capability gating and non-IMA legacy routing.
Final counts, browser evidence and governance outcome are recorded in
`.planning/changes/FEAT-20261009-PROVIDER-TASK-UI.md`.
No real IMA, service deployment, live credentials or internal token was used.
Backend integration and Docker/release validation belong to the parent task.

The website bundle was read only as a behavioral reference for composer sizing,
reading, answer copy and selection copy. No branding, logo, navigation, prompt
bank, queue behavior or animations were ported.

## Earlier Renderer Verification

- `npm ci --ignore-scripts`: completed; package manifests/lockfile unchanged.
- `node --test test/qa-experience.test.js test/client-answer-flow.test.js test/answer-renderer.test.js`:
  27/27 passed after the Markdown-copy review fix, including exact Markdown,
  citation boundaries, CRLF, clipboard fallback and 1500ms feedback reset tests.
- `npm test -- --test-reporter=dot`: 306/306 passed after the review fix.
- Isolated loopback fake HTTP/SSE only, observed in Chromium via Ego Browser:
  desktop main and 390x844 embed; compact dimensions 56px/28px; busy draft
  preservation and partial-copy control; stacked text above tools; no document
  horizontal overflow. Mobile return-latest center measured 195px in a 390px
  panel; compact height/radius also confirmed on mobile. Desktop/mobile
  screenshots were visually inspected outside Git. This is synthetic browser
  evidence, not real QA.
  Browser checks above cover the initial candidate; the copy-only follow-up was
  verified with synthetic jsdom tests, not repeated OS clipboard/browser tests.
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
