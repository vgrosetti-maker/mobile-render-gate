# mobile-render-gate

Renders every published page in a 390x844 phone viewport and fails the build when the computed result breaks on mobile.

## The problem

The CI was green and the page was broken on a phone. The checks before this one read the source: a coding agent looked at the CSS, saw a media query and reported "mobile ok". Nobody had rendered the page.

Reading CSS cannot answer the questions that matter on a phone. Whether iOS zooms into a form field depends on the font-size left after the cascade resolves. Whether a page scrolls sideways depends on layout. So this gate opens each page of the published folder in Chromium with a phone profile (390x844, device scale factor 2, touch) and judges what the browser computed.

This is what it prints for the bad fixture in this repo:

```text
$ node check-mobile.mjs fixtures/bad
mobile FAIL: 5 violation(s) in 1 page(s) checked (390x844)
summary: horizontal-scroll=1 input-below-16px=1 tap-target-below-44px=1 text-below-14px=2

  index.html
    [horizontal-scroll] div.wide ("This box is 600px wide i") overflows the viewport by 210px (right edge at 600px, width 600px)
  index.html
    [input-below-16px] #email has font-size 13px (minimum 16px, below that iOS zooms in on focus)
  index.html
    [tap-target-below-44px] button.tiny-button ("x") is 24x24px (minimum 44x44px)
  index.html
    [text-below-14px] p.fine-print ("This paragraph renders a") has font-size 10px (minimum 14px, reading text floor)
  index.html
    [text-below-14px] button.tiny-button ("x") has font-size 13.3333px (minimum 14px, reading text floor)
```

## Quick start

Requires Node 20 or newer and a Chrome or Chromium on the machine.

```bash
git clone https://github.com/vgrosetti-maker/mobile-render-gate.git
cd mobile-render-gate
npm ci
node check-mobile.mjs fixtures/good   # exit 0
node check-mobile.mjs fixtures/bad    # exit 1
node check-mobile.mjs path/to/your/_site
```

Point it at the folder you publish (the build output), not at the repository root. Auditing the root checks files that never ship. The default folder is `_site`.

The only dependency is `playwright-core`, which does not download a browser. The gate looks for one in this order:

1. the path in the `MOBILE_GATE_BROWSER` environment variable
2. the system Chrome (present on GitHub's `ubuntu-latest` runners)
3. a Chromium installed with `npx playwright install chromium`

If none opens, the run exits 2 and lists what it tried.

In GitHub Actions, after the step that builds your site:

```yaml
      - uses: actions/checkout@v4
        with:
          repository: vgrosetti-maker/mobile-render-gate
          path: mobile-render-gate
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
        working-directory: mobile-render-gate
      - run: node mobile-render-gate/check-mobile.mjs _site
```

## What it checks

Ten invariants are always on. Each one is measured in the rendered page.

| Id | What it measures | Why |
|---|---|---|
| `no-viewport-meta` | The page has no `<meta name="viewport">`. | Without it the phone lays the page out at desktop width. |
| `horizontal-scroll` | The page scrolls sideways by more than 1px, or a visible element ends past the 390px edge without an ancestor that clips it. | Content is cut off or the page slides under the finger. |
| `input-below-16px` | A visible `input`, `textarea` or `select` has a computed font-size under 16px. | Safari on iOS zooms in when such a field is focused. |
| `tap-target-below-44px` | A link, button, `[role="button"]` or `summary` is smaller than 44x44px. Links inline in a sentence are exempt. | The 44px target of WCAG 2.5.5, with the same inline exception. |
| `text-below-14px` | Reading text has a computed font-size under 14px. | Below that a paragraph is hard to read on a phone. |
| `label-below-12px` | A decorative label has a computed font-size under 12px. A text only counts as a label when it is uppercase and has positive letter-spacing. | Eyebrows and tags are small by design. They get a lower floor, and only when they prove both marks. |
| `image-without-dimensions` | A visible `<img>` has neither `width` and `height` attributes nor a CSS `aspect-ratio`. | The image pushes the layout when it loads. |
| `vertical-scroll-snap-full-page` | An element with vertical `scroll-snap-type` is at least 85% of the screen height. | That is a whole page paginated by snap. Horizontal carousels are not reported. |
| `broken-asset` | An image request failed or answered HTTP 400 or higher. | The visitor sees a hole where the image should be. |
| `raw-vh-without-fallback` | A rule sets `height`, `min-height` or `max-height` in `vh` with no `svh`, `dvh` or `lvh` value in the same block. | `100vh` ignores the Safari toolbar on iOS and the content gets cut. |

A file that is a site ownership verification token (one line such as `google-site-verification: ...`, no tags, at most 512 bytes) is skipped, and the run prints its name with the reason.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every invariant passed. |
| 1 | At least one invariant was violated. |
| 2 | The collection did not run. |

Exit 2 exists so that "I could not check" never looks like "it is fine". The run exits 2 when the folder is missing or has no page, no browser opens, `playwright-core` is not installed, a page answers HTTP 400 or higher, a font or stylesheet fails to load or does not arrive in 15 seconds, or a flag is unknown. A typo in a flag is a collection failure too, because a silently ignored flag would turn a check off.

The CI of this repo runs five cases: exit 0 on the good fixture, exit 1 on the bad one, exit 2 on a missing folder, and exit 1 for each of the two typography flags below.

## Optional typography checks

Two checks encode rules that belong to one site, so they are off until you pass the flag.

```bash
node check-mobile.mjs _site --fonts-css=/assets/css/fonts.css --font-canon="Inter Tight,Inter,sans-serif" --exempt-prefix=work/
```

| Flag | Id | What it checks |
|---|---|---|
| `--fonts-css=<url path>` | `fonts-css-not-loaded` | Every page got an HTTP 200 for this font stylesheet. The witness is the network, so a `<link>` that never arrived does not count. |
| `--font-canon=<a,b,c>` | `font-family-off-canon` | Every computed `font-family` stack stays inside this list. Reported once per stack, since one wrong stack is one wrong CSS rule. |
| `--exempt-prefix=<a,b>` | | Page path prefixes exempt from the two checks above. They are still checked for everything else. |

In Git Bash on Windows, an argument that starts with `/` is rewritten into a disk path. Prefix the command with `MSYS_NO_PATHCONV=1` when you pass `--fonts-css=/...`.

## Design notes

Each threshold in `check-mobile.mjs` carries a comment with the measurement behind it. Four of them shaped the tool.

**`document.fonts.ready` does not prove the font arrived.** With the font host blocked it resolves anyway and `document.fonts.check()` still returns true. A button then measured 41px with the fallback font and 45px with the real one, and a report swung between 160 and 159 violations from run to run. The gate watches the font and stylesheet requests on the network and exits 2 when one fails. Measuring with the fallback font is measuring another site.

**`scrollWidth` condemns pages the visitor never sees broken.** A home page with a pinned horizontal gallery had a `scrollWidth` of 1108px while `window.scrollX` never left 0. The gate scrolls the page sideways and reads how far it went.

**`body { overflow-x: hidden }` mutes that measurement.** The overflow is still there and the page can no longer scroll to show it. So the gate also measures each element against the fixed 390px width. It does not compare against `window.innerWidth`: with a header overflowing to 425px, `window.innerWidth` returned 425 as well.

**An error page has fewer defects than the real page.** Playwright's `goto` resolves normally on a 404. One run reported 436 violations instead of 449 because some pages had been measured as error pages. A document that answers HTTP 400 or higher is now a collection failure.

The decision lives in `evaluateMobile()`, a pure function over the snapshot the browser collected, so each invariant can be tested with a hand-written snapshot and no browser.

## Limits

- One viewport, 390x844. A defect that only appears at 360px or on a tablet is not caught.
- Chromium, not Safari. The iOS rules are checked through their known causes (font-size under 16px, raw `vh`), not by reproducing Safari.
- No interaction. Menus are not opened, forms are not filled, and hidden elements are not measured.
- Static `.html` files in one folder. Routes that exist only on the server or in JavaScript routing are not visited.
- `broken-asset` covers images only.

## License

MIT. See [LICENSE](LICENSE).

The rule that a collection failure is never green comes from [agent-verification-lessons](https://github.com/vgrosetti-maker/agent-verification-lessons). Built at [Nord Leads](https://nordleads.org).
