# Browser rendering dependencies

These local browser assets are copied from locked npm development dependencies by `npm run build:web-vendor`. They are bundled into the public package so answer rendering does not load executable code from a CDN.

- `marked.umd.js`: Marked 15.0.12, MIT; full license in `marked.LICENSE.md`.
- `purify.min.js`: DOMPurify 3.4.16, Apache-2.0 or MPL-2.0; full license in `dompurify.LICENSE`.

Update the npm lockfile and regenerate these files together. The application sanitizes rendered Markdown before inserting HTML into the page.
