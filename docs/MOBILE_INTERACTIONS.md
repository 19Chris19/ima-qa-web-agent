# Touch references and mobile composer

Adjacent web references previously enlarged their hit areas with absolutely
positioned 44px pseudo-elements. Those invisible areas overlapped: tapping the
visible `1` could activate `2`. The reference map itself was correct.

On devices with a coarse pointer, each interactive reference now reserves at
least 44 × 44 CSS pixels in inline layout. Its blue number remains a small
superscript-style label inside that area. Adjacent targets cannot overlap and
wrap naturally when space runs out. Green knowledge references stay static and
have no preview or link. Fine-pointer desktop markers remain compact.

Mobile composers have at least 32 CSS pixels of bottom spacing and at least
8 pixels above `env(safe-area-inset-bottom)`, whichever requires more room,
in the standalone and embedded pages. This avoids adding the full 32px again
on top of a large home-indicator inset. The viewport
meta tag opts into `viewport-fit=cover` and `interactive-widget=resizes-content`
on browsers that support it. No fixed screen coordinates or transforms are used
to move the composer, so the chat's normal layout reserves its space.

## Regression checks

```sh
npm test
npm run test:mobile-ui
```

The latter needs Node 22 and a Chromium executable (`google-chrome` by default;
set `CHROME_PATH` if needed). CI runs it separately from the Node unit suite.
It starts an isolated loopback fixture with the actual page HTML, CSS and
Markdown renderer, then uses native CDP touch events. It never loads account
data, connects to a real Provider, submits an IMA question or fetches a cover.

The same `runMobileUiChecks` helper can run with an existing Ego Lite Page.
It checks the visible label and both edges of every occurrence, including
adjacent, wrapped, table and multiple-destination references; exact source
selection; static knowledge references; draft retention; desktop hover/native
links; and composer clearance at 320/390/430px and a short layout viewport.
Touch layout also covers landscape and a 1024px tablet. Background-tab frame
waiting is bounded, and sheet animations are finished before locating close.

Chromium emulation does not replace physical iOS Safari/Android Chrome testing.
The short viewport checks cover layout resize, not a real software keyboard;
safe-area values, browser chrome and iOS keyboard panning need device acceptance
before release. Existing services are not restarted by these tests.
