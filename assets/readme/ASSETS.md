# README asset provenance

Updated 2026-10-15 for Provider v0.6.1, source revision
`880d816a431595cae8c1e3aa5cbc97ae2a7f4161`.

## Sources

- `hero-v2.svg` and `workflow-v2.svg`: editable, deterministic project diagrams.
- `screenshots/qa-desktop.png` and `screenshots/admin-desktop.png`: current public
  frontend rendered with **Synthetic HTTP** responses, not real IMA outputs.
- `source/synthetic-http.json`: fictional answer, sources, accounts and dates.
  Names, capacity, timing, expiry dates and readiness are examples, not live state.
- Legacy assets remain for historical links; the current README uses the v2 set.

No credentials, real answers, browser profile or private website brand assets
are included. No ImageGen or Gemini design output is claimed. Installed
beautify-github-readme matches upstream `d6562a5`; Gemini direction returned 503.

## Reproduce

1. Run `npm ci` in a clean fixed checkout.
2. Run `node assets/readme/source/preview.mjs 4981`.
3. In a disposable browser, open `http://127.0.0.1:4981/`, select the synthetic
   recent conversation, and capture at 1366 x 900 CSS pixels. Open `/admin.html`
   on the same synthetic server for the account view; no token is required by
   these fixtures. Do not point this fixture server at a real service.
4. `/readme-preview` renders the local Markdown for wide/narrow and theme checks.
   The preview is local trusted content, not a general HTML rendering endpoint.
5. Stop the preview process when finished. It accepts only GET/HEAD and cannot
   submit a question, mutate an account or call upstream IMA.

SVGs own their background and use local system fonts. Keep the explanatory
Markdown even when diagrams are changed; small screens must not depend on image
labels alone. Generated PNGs are budgeted below 1.5 MB each.
