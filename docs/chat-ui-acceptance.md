# Native chat presentation acceptance

The main and embedded pages use `chat_v1` with the existing native JavaScript, Markdown sanitizer and animation-frame streaming painter. No React runtime or hover-time webpage fetch is introduced.

- Web superscripts open supplied title/domain/excerpt on hover, focus or tap. The superscript never navigates; only “打开网页” does. Tab/ArrowDown enters the card; Escape, close and outside tap dismiss it. Missing excerpts are omitted.
- Knowledge superscripts are static. The old knowledge title/snippet cards are hidden. Old bare numbers and unmapped records stay literal/static; code and formulas never become citations.
- “回答过程” folds real retrieval/search/generation stages. Answer-related followups are text only, fill the current composer and never submit. Any existing draft disables filling.
- Each completed, structurally valid table has HTML+TSV copy and UTF-8 BOM CSV download. Both clipboard formats and CSV neutralize spreadsheet formula prefixes; numeric negatives remain numbers. In-progress exports are disabled. A valid table in an interrupted answer is explicitly marked as partial.
- Whole-answer Markdown copy remains; code blocks also have their own copy button. Incremental painting retains unchanged blocks and does not auto-scroll a reader away from older content.

Automated synthetic tests cover key/label mismatch, source reordering, repeated URLs, late metadata, mixed provenance, privacy projection, EOF/terminal behavior, task history/reconnect/idempotency, drafts, code/formulas, clipboard formats and CSV special characters. The actual main/embed composer flows are also exercised with synthetic transport.

Before production rollout, separately confirm real IMA reference/suggestion frames, real streaming behavior, a real mobile device, and pasting into Excel/Numbers/documents. Synthetic acceptance does not claim those checks or a production deployment.
