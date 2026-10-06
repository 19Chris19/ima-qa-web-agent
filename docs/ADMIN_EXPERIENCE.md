# Provider Admin Experience

Status: **candidate**, based on `0db3fc2`. Not deployed or verified against live
accounts. Integration belongs to the parent task. No runtime, credential,
dependency-lock or backend source changes are included.

## Account workspace

- Compact semantic account table; account name and row background open a right
  details dialog. On phones the table becomes a labeled two-column row layout
  and the dialog fills the viewport.
- One primary row command: re-login when required, enable for a disabled
  nonduplicate account, otherwise details. Check, refresh, qualification,
  re-login, enable/disable and delete remain in More. Qualification retains its
  real-request confirmation; delete retains its confirmation.
- More uses a native disclosure with labeled action buttons, Tab/arrow/Home/End
  navigation, Escape, outside-click and focus-out dismissal. It intentionally
  uses a button group, not a partially implemented ARIA application menu.
- The native modal dialog has a named heading, initial close-button focus,
  Tab/Shift-Tab containment, Escape and focus restoration to the account name.
  If the account disappears, focus returns to the account-count heading.
- Navigation links target only existing account, enrollment, exercise and report
  panels. Exercise/report links appear only when their bootstrap feature exists.
  Existing enrollment IDs, exercise controls and report/review handlers remain.
- Motion is disabled under `prefers-reduced-motion: reduce`; visible focus
  indicators and text labels accompany status colors.

## State contract

`account.management` is consumed as provided by the maintenance branch:

```text
knowledge: { state, qualified, verifiedAt }
web: { state }
session: { state }
maintenance: {
  state, nextCheckAt, nextRetryAt, lastCheckAt, refreshEligibleAt,
  expiryKnown, tokenExpiresAt, refreshTokenExpiresAt, lastSuccessfulRefreshAt
}
schedulable
```

Knowledge states: ready, pending, needs_login, disabled, verifying, busy, cooling.
When management knowledge is absent, `payload.readiness.accounts` is the only
qualification fallback; no evidence means pending. Health flags never qualify
an account. Web and session remain independent ready/unavailable/unknown states.
`web_context_missing` does not mark knowledge QA failed, including legacy detail
copy. Knowledge-access health records are labeled separately from QA evidence.

Maintenance supports unobserved, disabled, checking, retry_wait and scheduled;
missing/unknown states show unknown. Additional descriptive states remain
defensive mappings. Only actual supplied timestamps are rendered, with browser
timezone and offset. Missing schedules show not provided; missing upstream
expiry shows unknown (not supplied by upstream). No next time is calculated.
Top schedulable/capacity counts prefer readiness. Legacy basicHealthy is not
used as QA availability. Qualified count uses explicit qualified evidence.

Initial load and reload issue GET only. Reading state never initiates checks,
refreshes or QA probes. Each mutation requires an explicit operator action.

## Enrollment identity conflict

`identity_conflict` remains an active cancellable enrollment state. Original
identity is preserved. The only conflict-specific mutation is:

```text
POST /api/admin/enrollments/:taskId/identity
{ "action": "add", "name": "synthetic-new-name" }
```

The response uses the existing `{ enrollment }` envelope. Empty/existing names
are rejected locally, duplicate clicks are blocked, and polling resumes after
acceptance. Cancellation continues to use DELETE on the enrollment resource.
No replace action is sent by the conflict UI. Backend still owns atomic identity
preservation and uniqueness enforcement. Parent must confirm the sibling
enrollment contract during integration.

## Verification

Synthetic jsdom tests: `node --test test/admin-experience.test.js test/admin-ui.test.js`.
Full regression: `npm test`. Browser preview uses an isolated data-URL page,
synthetic in-memory fetch responses and no real admin requests. Screenshots are
outside Git at `/tmp/provider-admin-ui-*.png`.

Final candidate run: `npm test -- --test-reporter=spec`, 300 passed, 0 failed
(12 new jsdom cases). Chromium previews at 320, 390, 768 and 1440 pixels had no
horizontal overflow. Tab/Shift-Tab containment, Escape/focus return and reduced
motion were checked in the browser. Screenshots include desktop and mobile,
with and without the details drawer. This is not a Safari or screen-reader audit.

The target repository has no `scripts/check_governance.py`; invoking its required
CI command fails with file-not-found. No out-of-scope governance files were
added. The parent is handling the separately observed npm audit dependency issue;
package files are untouched. No live-account, deployment, browser-helper or
real enrollment success is claimed.
