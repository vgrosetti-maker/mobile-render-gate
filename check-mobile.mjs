#!/usr/bin/env node
// mobile-render-gate
//
// Renders every PUBLISHED page in a phone viewport and asserts invariants on
// the COMPUTED result, never on the source code. The reason: iOS zoom depends
// on the font-size left after the cascade and after the root clamp resolves,
// and no reading of the CSS reveals that.
//
// Point it at the folder you actually publish (the build output), not at the
// repository root: auditing the root audits files that never ship and misses
// the cut the visitor receives.
//
// Exit codes:
//   0 = every invariant passed          -> green
//   1 = at least one invariant violated -> RED
//   2 = the collection did not run      -> RED, always
// A collection failure never exits green: "I don't know" is not "it's fine".
//
// The decision lives in evaluateMobile(), which is PURE over the snapshot. The
// browser only collects raw data, so every invariant can have a negative test
// without a browser.

import { readdirSync, statSync, existsSync, createReadStream, readFileSync } from 'node:fs';
import { join, resolve, relative, sep, extname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** iPhone 12/13/14 in CSS px. */
export const VIEWPORT = { width: 390, height: 844 };

/** Below this, Safari on iOS zooms in automatically when the field is focused. */
export const MIN_INPUT_FONT_PX = 16;

/** WCAG 2.2 SC 2.5.5 (Target Size, Enhanced). */
export const MIN_TAP_PX = 44;

/**
 * Floating point slack when reading the box, not design slack.
 *
 * Measured: a target of exactly 44px (flex item with `align-items:center` and
 * the real webfont) comes back from getBoundingClientRect as 43.99999...px at
 * DPR 2, and not always, about 1 run in 3. Without a tolerance the gate printed
 * "is 276x44px (minimum 44x44px)", contradicting itself on one line, because
 * it rounded only in the message and compared the raw float. Worse, the
 * obvious fix was to deform the site to please the meter (raise the CSS to
 * 44.5px). Half a hundredth of a pixel hides no target that is really small:
 * 43.9px is still reported.
 */
export const SUBPIXEL_TOLERANCE_PX = 0.05;

/** Tap target invariant, pure so it can have a negative test without a browser. */
export function targetTooSmall({ width, height }, min = MIN_TAP_PX) {
  const floor = min - SUBPIXEL_TOLERANCE_PX;
  return width < floor || height < floor;
}

/**
 * Reading floor on a phone. A 16px floor would condemn the whole type scale of
 * a normal site (eyebrow, badge and h2 would end up nearly the same size);
 * 14px catches what is actually unreadable and leaves the scale standing. It
 * does not inherit the 16px of the input rule: there the reason is iOS zoom,
 * here it is the eye.
 *
 * Applies to READING TEXT: paragraph, list item, table cell, body link.
 * Anything the visitor reads in sequence.
 */
export const MIN_TEXT_PX = 14;

/**
 * Floor for the DECORATIVE LABEL. Technical labels (eyebrow, tag, index, nav,
 * footer) are uppercase with open letter-spacing and drawn small on purpose.
 * Raising them to 14px destroys the design without gaining legibility, because
 * nobody reads them in sequence. Two floors instead of loosening the only one:
 * 12px is granted only to text that proves both marks of a label (see
 * `isDecorativeLabel`); whatever cannot prove them stays on the reading floor.
 */
export const MIN_LABEL_PX = 12;

/**
 * A text counts as a decorative label when it has BOTH marks of a technical
 * label: uppercase (through `text-transform:uppercase`, OR because the content
 * itself was typed in capitals, OR because the content has NO letter at all,
 * like a "01 / 02" counter, which has no case to judge and cannot be failed
 * for it) AND positive `letter-spacing`. Both together on purpose: uppercase
 * alone would match an ordinary heading; letter-spacing alone would match a
 * paragraph spaced by accident. Pure, with its own negative test.
 */
export function isDecorativeLabel({ textTransform, letterSpacing, textContent }) {
  const letterSpacingPx = typeof letterSpacing === 'number' ? letterSpacing : parseFloat(letterSpacing);
  const spaced = Number.isFinite(letterSpacingPx) && letterSpacingPx > 0;
  if (!spaced) return false;
  if (textTransform === 'uppercase') return true;
  return textWithoutLowercase(textContent);
}

/**
 * True when the text is mostly uppercase (more than half of the letters) OR
 * has no letter at all (digits, punctuation, symbols: "01 / 02", "*"). With
 * no letter there is no case to fail the test, and treating absence of proof
 * as a failure was a hole: a numeric label could never qualify. Unicode aware.
 */
function textWithoutLowercase(text) {
  const letters = String(text ?? '').match(/\p{L}/gu);
  if (!letters || letters.length === 0) return true;
  const upper = letters.filter((c) => /\p{Lu}/u.test(c)).length;
  return upper / letters.length > 0.5;
}

/**
 * Sub-pixel borders and transforms return a scrollWidth with a remainder the
 * user can never scroll to. Reporting it would be a false alarm.
 */
export const SCROLL_TOLERANCE_PX = 1;

/**
 * Fraction of the viewport height from which an element with a vertical
 * scroll-snap-type becomes a suspect of "whole page paginated by snap". Below
 * it, it is a tall card inside a normal list, and reporting it would be noise.
 */
export const VERTICAL_SNAP_THRESHOLD = 0.85;

const normalizeFamily = (name) =>
  name
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .toLowerCase();

/**
 * Families of a COMPUTED `font-family` that are outside the canon, in the
 * order they appear in the stack and with the name as the browser returned it.
 *
 * Blink quotes a computed family only when it has to (`"Inter Tight", Inter,
 * sans-serif`) and keeps the author's case, so the comparison normalizes
 * quotes, spaces and case. Comparing the whole string would give a false
 * negative on the first reordering of the stack.
 */
export function familiesOffCanon(stack, canon) {
  if (typeof stack !== 'string') return [];
  const allowed = new Set((canon ?? []).map(normalizeFamily));
  return stack
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .filter((f) => !allowed.has(f.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

/**
 * An inline link in the middle of a paragraph is exempt from the 44px target
 * by WCAG 2.5.5 itself ("in a sentence or block of text"). Without this
 * exemption the gate would report every text link of a blog and become noise
 * nobody reads.
 */
function exemptFromTarget(target) {
  return target.display === 'inline';
}

/**
 * @param {Array<object>} snapshots one per published page
 * @param {object} [options] the two typography invariants are OPT-IN, because
 *   they encode one site's own rules and a generic gate cannot guess them:
 * @param {string|null} [options.fontsCss] URL path of the self-hosted font
 *   stylesheet every page must load (e.g. `/assets/css/fonts.css`)
 * @param {string[]|null} [options.fontCanon] the only families a page may
 *   resolve to
 * @param {string[]} [options.exemptPrefixes] page path prefixes exempt from
 *   the two typography invariants (never from `broken-asset`)
 * @returns {{ok: boolean, errors: Array<{page:string,reason:string,detail:string}>, pages:number}}
 */
export function evaluateMobile(snapshots, options = {}) {
  const { fontsCss = null, fontCanon = null, exemptPrefixes = [] } = options;

  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    // A broken build that produced an empty folder cannot exit green: the
    // gate would have checked nothing.
    throw new Error(
      'collection failure: no page to check (the published folder is empty or was not built)',
    );
  }

  const errors = [];
  const report = (page, reason, detail) => errors.push({ page, reason, detail });

  for (const snap of snapshots) {
    const { page } = snap;

    if (!snap.hasViewportMeta) {
      report(page, 'no-viewport-meta', 'the page does not declare <meta name="viewport">');
    }

    // We measure REAL SCROLLING, not `scrollWidth`. A home page with a
    // horizontal gallery pinned by a scroll library can have a scrollWidth of
    // 1108px while window.scrollX never leaves 0: the finger cannot reach it.
    // An invariant on scrollWidth would condemn that page for a defect the
    // visitor does not feel, and the gate would become ignored noise.
    if (snap.maxScrollX > SCROLL_TOLERANCE_PX) {
      report(
        page,
        'horizontal-scroll',
        `the page scrolls ${Math.round(snap.maxScrollX)}px sideways ` +
          `(content of ${snap.scrollWidth}px in a ${VIEWPORT.width}px viewport)`,
      );
    }

    // The other half of the same defect. `body{overflow-x:hidden}` zeroes
    // `maxScrollX` FOREVER: the overflow is still there, only mute. Measuring
    // element by element lets the invariant report again without depending on
    // the body allowing a scroll. A detector that cannot report anything
    // proves nothing. Same reason, separate count: they are two defects.
    for (const leak of snap.overflows ?? []) {
      // Same tolerance as scrolling, for the same reason.
      if (leak.right - VIEWPORT.width <= SCROLL_TOLERANCE_PX) continue;
      report(
        page,
        'horizontal-scroll',
        `${leak.selector} overflows the viewport by ${Math.round(leak.right - VIEWPORT.width)}px ` +
          `(right edge at ${Math.round(leak.right)}px, width ${Math.round(leak.width)}px)`,
      );
    }

    for (const field of snap.inputs ?? []) {
      if (field.fontSize < MIN_INPUT_FONT_PX) {
        report(
          page,
          'input-below-16px',
          `${field.selector} has font-size ${field.fontSize}px (minimum ${MIN_INPUT_FONT_PX}px, ` +
            'below that iOS zooms in on focus)',
        );
      }
    }

    for (const target of snap.targets ?? []) {
      if (exemptFromTarget(target)) continue;
      if (targetTooSmall(target)) {
        report(
          page,
          'tap-target-below-44px',
          `${target.selector} is ${Math.round(target.width)}x${Math.round(target.height)}px ` +
            `(minimum ${MIN_TAP_PX}x${MIN_TAP_PX}px)`,
        );
      }
    }

    for (const text of snap.texts ?? []) {
      const label = isDecorativeLabel(text);
      const floor = label ? MIN_LABEL_PX : MIN_TEXT_PX;
      if (text.fontSize < floor) {
        report(
          page,
          label ? 'label-below-12px' : 'text-below-14px',
          `${text.selector} has font-size ${text.fontSize}px (minimum ${floor}px, ` +
            `${label ? 'decorative label' : 'reading text'} floor)`,
        );
      }
    }

    for (const img of snap.images ?? []) {
      if (!img.hasIntrinsicSize && !img.hasAspectRatio) {
        report(
          page,
          'image-without-dimensions',
          `${img.selector} declares neither width+height nor aspect-ratio (it pushes the layout when it loads)`,
        );
      }
    }

    // Vertical scroll-snap covering almost the whole screen: section
    // pagination by snap. A horizontal carousel (scroll-snap-type:x) does not
    // fall here.
    for (const suspect of snap.verticalSnapSuspects ?? []) {
      report(
        page,
        'vertical-scroll-snap-full-page',
        `${suspect.selector} has scroll-snap-type:${suspect.scrollSnapType} on a box of ` +
          `${Math.round(suspect.height)}px (close to the screen height); keep snap for ` +
          'horizontal carousels',
      );
    }

    const exempt = exemptPrefixes.some((prefix) => page.startsWith(prefix));

    // `fonts-css-not-loaded` (opt-in). The witness is the NETWORK (a 200 for
    // the stylesheet), not the DOM: it is the same witness openMeasurablePage()
    // uses to prove the page downloaded a font face, and switching witnesses
    // halfway would let through a declared <link> that never arrived. A
    // snapshot without the field does NOT pass as green.
    if (fontsCss && !exempt && !snap.loadedFontsCss) {
      report(
        page,
        'fonts-css-not-loaded',
        `the page did not load ${fontsCss} (without the stylesheet the page draws in its own family)`,
      );
    }

    // `font-family-off-canon` (opt-in). Measures the COMPUTED EFFECT, not the
    // declaration in the source: grepping the stylesheet does not reveal which
    // family the blog <h1> ended up in after the cascade and the page's own
    // inline CSS.
    //
    // Grouped by computed STACK, not by element: the stack is the wrong CSS
    // rule, and an <h1> and an <h2> with the same stack are one defect.
    if (fontCanon && !exempt) {
      const reportedStacks = new Set();
      for (const { selector, fontFamily } of snap.fontFamilies ?? []) {
        if (reportedStacks.has(fontFamily)) continue;
        const off = familiesOffCanon(fontFamily, fontCanon);
        if (off.length === 0) continue;
        reportedStacks.add(fontFamily);
        report(
          page,
          'font-family-off-canon',
          `${selector} resolves font-family to "${fontFamily}", off canon: ` +
            `${off.join(', ')} (canon: ${fontCanon.join(', ')})`,
        );
      }
    }

    // `broken-asset`. An image that returns >=400 from the gate's own local
    // server. Not a collection failure (the page rendered): a violation, exit
    // 1 like the others. Applies to exempt prefixes TOO.
    for (const asset of snap.brokenAssets ?? []) {
      const cause = asset.status > 0 ? `HTTP ${asset.status}` : (asset.detail ?? 'no response');
      report(
        page,
        'broken-asset',
        `${asset.url} did not load (${cause}): the visitor sees a hole where the image should be`,
      );
    }

    // Raw 100vh without an svh/dvh pair in the SAME rule block: without the
    // pair, the Safari toolbar on iOS cuts the content (100vh ignores the
    // toolbar, svh does not).
    for (const decl of snap.rawVhDeclarations ?? []) {
      report(
        page,
        'raw-vh-without-fallback',
        `rule "${decl.selector}" declares ${decl.property}:${decl.value} without an ` +
          'svh/dvh pair in the same block (the Safari toolbar on iOS cuts the content)',
      );
    }
  }

  return { ok: errors.length === 0, errors, pages: snapshots.length };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function collectionFailure(message, cause) {
  const error = new Error(`COLLECTION FAILURE: ${message}`);
  error.isCollectionFailure = true;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Runs INSIDE the page. It must be self-contained: no outer scope.
 * Returns raw data; evaluateMobile() is the judge.
 */
/* c8 ignore start - runs in the browser */
export async function pageSnapshot(viewport) {
  const { width: viewportWidth, height: viewportHeight } = viewport;
  // Settling does NOT live here: openMeasurablePage() hands over a page that
  // has already settled, so a screenshot taken through it sees the same instant.
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // REAL sideways scrolling: the only number that matches what the finger does.
  //
  // `behavior: 'instant'` is NOT a detail. With `scroll-behavior: smooth`, a
  // read one frame later returns 0 even on a page that really scrolls. That is
  // how this measurement once hid the horizontal scroll of two pricing pages.
  // A false negative in a gate is worse than a false positive: it produces the
  // silent green.
  const scrollXBefore = window.scrollX;
  window.scrollTo({ left: 99999, top: window.scrollY, behavior: 'instant' });
  await frame();
  await new Promise((r) => setTimeout(r, 150));
  const maxScrollX = window.scrollX;
  window.scrollTo({ left: scrollXBefore, top: window.scrollY, behavior: 'instant' });
  await frame();

  const selectorOf = (el) => {
    if (el.id) return `#${el.id}`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    const text = (el.textContent || '').trim().slice(0, 24);
    const base = cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
    return text ? `${base} ("${text}")` : base;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // Only elements with their own text count: otherwise every ancestor inherits
  // the child's text and one 9px <span> becomes 40 identical reports up the tree.
  const hasOwnText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

  /**
   * Horizontal overflow per ELEMENT. Whatever clips the overflow inside its
   * own box (a pinned gallery, a carousel) is contained on purpose and is not
   * a defect: the finger never gets there. Whatever is only hidden by the
   * body's `overflow-x:hidden` is: the content is cut on the visitor's screen.
   * That is why the walk up ignores body and html.
   */
  const containedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') return true;
    }
    return false;
  };

  const FIELDS = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select';
  const TARGETS = 'a[href], button, [role="button"], input[type="submit"], input[type="button"], summary';

  // Suspect vertical scroll-snap: computed, not read from the source CSS. What
  // separates "normal carousel" from "whole page paginated by snap" is a box
  // height close to the full screen, hence the threshold and not only the axis.
  const verticalSnapSuspects = Array.from(document.querySelectorAll('body *'))
    .filter(visible)
    .map((el) => ({ el, type: getComputedStyle(el).scrollSnapType }))
    .filter(({ type }) => !!type && type !== 'none' && /(^|\s)(y|block)(\s|$)/.test(type))
    .map(({ el, type }) => {
      const r = el.getBoundingClientRect();
      return { selector: selectorOf(el), height: r.height, scrollSnapType: type };
    })
    // 0.85 = VERTICAL_SNAP_THRESHOLD. It cannot reference the module constant:
    // this function runs SELF-CONTAINED in the browser through page.evaluate.
    .filter((o) => o.height >= viewportHeight * 0.85);

  // Raw 100vh without an svh/dvh pair in the SAME rule block. This reads the
  // CSSOM of the SERVED page: the only way to catch this defect, because
  // headless Chromium has no Safari toolbar for the behaviour to show up in
  // the computed value (svh == vh here).
  const rawVhDeclarations = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let text = '';
      try {
        text = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join('\n');
      } catch {
        continue; // cross-origin sheet without CSSOM access: not our CSS
      }
      const blocks = text.match(/[^{}]+\{[^{}]*\}/g) ?? [];
      for (const block of blocks) {
        const decl = block.match(/(height|min-height|max-height)\s*:\s*(\d+(?:\.\d+)?)vh\b/i);
        if (!decl) continue;
        if (/\d(?:s|d|l)vh\b/i.test(block)) continue; // fallback pair in the same block
        rawVhDeclarations.push({
          selector: block.split('{')[0].trim(),
          property: decl[1],
          value: `${decl[2]}vh`,
        });
      }
    }
  } catch {
    /* CSSOM unavailable (test DOM stub): do not sink the collection over this */
  }

  return {
    maxScrollX,
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
    ),
    hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    // Compared against `viewportWidth` (a known constant, passed in), NEVER
    // against `window.innerWidth`. Measured: with a header overflowing to
    // 425px, `window.innerWidth` also returns 425, because the mobile layout
    // viewport expands to fit the content that should have overflowed.
    // Comparing the overflow against that inflated witness is comparing the
    // suspect against itself. Only a fixed number, from the emulated device
    // and never read from the page, reports it.
    overflows: Array.from(document.querySelectorAll('body *'))
      .filter(visible)
      .filter((el) => !containedByAncestor(el))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { selector: selectorOf(el), right: r.right, width: r.width };
      })
      .filter((o) => o.right > viewportWidth),
    // COMPUTED font-family stacks, one entry per distinct stack (grouping here
    // is reduction of raw data, not judgement: evaluateMobile() knows the canon).
    fontFamilies: (() => {
      const seen = new Set();
      const found = [];
      for (const el of Array.from(document.querySelectorAll('body *'))
        .filter(hasOwnText)
        .filter(visible)) {
        const stack = getComputedStyle(el).fontFamily;
        if (!stack || seen.has(stack)) continue;
        seen.add(stack);
        found.push({ selector: selectorOf(el), fontFamily: stack });
      }
      return found;
    })(),
    texts: Array.from(document.querySelectorAll('body *'))
      .filter(hasOwnText)
      .filter(visible)
      .map((el) => {
        const s = getComputedStyle(el);
        // Own text, not the descendant's, so "uppercase" judges what this
        // element really writes.
        const ownText = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(' ');
        return {
          selector: selectorOf(el),
          fontSize: parseFloat(s.fontSize),
          textTransform: s.textTransform,
          letterSpacing: s.letterSpacing,
          textContent: ownText,
        };
      }),
    inputs: Array.from(document.querySelectorAll(FIELDS))
      .filter(visible)
      .map((el) => ({
        selector: selectorOf(el),
        fontSize: parseFloat(getComputedStyle(el).fontSize),
      })),
    targets: Array.from(document.querySelectorAll(TARGETS))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          selector: selectorOf(el),
          width: r.width,
          height: r.height,
          display: getComputedStyle(el).display,
        };
      }),
    images: Array.from(document.querySelectorAll('img'))
      .filter(visible)
      .map((el) => ({
        selector: selectorOf(el),
        hasIntrinsicSize: el.hasAttribute('width') && el.hasAttribute('height'),
        hasAspectRatio: getComputedStyle(el).aspectRatio !== 'auto',
      })),
    verticalSnapSuspects,
    rawVhDeclarations,
  };
}
/* c8 ignore stop */

/**
 * Browser resolution order. We use `playwright-core`, which does NOT download
 * a browser on install: the repo does not carry 150MB of binary to run one
 * check. In exchange, we need to find a Chromium that already exists:
 *
 *   1. MOBILE_GATE_BROWSER - explicit path, wins over everything (escape hatch)
 *   2. "chrome" channel    - system Chrome (present on GitHub's ubuntu-latest
 *                            runners)
 *   3. downloaded chromium - for whoever ran `npx playwright install chromium`
 *
 * If none opens, it is a COLLECTION FAILURE and the report says what was
 * tried. Never "found no browser, so it's fine".
 */
export async function launchBrowser(chromium, env = process.env) {
  const candidates = [];
  if (env.MOBILE_GATE_BROWSER) {
    candidates.push({
      name: `MOBILE_GATE_BROWSER=${env.MOBILE_GATE_BROWSER}`,
      options: { executablePath: env.MOBILE_GATE_BROWSER },
    });
  }
  candidates.push({ name: 'system chrome channel', options: { channel: 'chrome' } });
  candidates.push({ name: 'playwright chromium', options: {} });

  const attempts = [];
  for (const { name, options } of candidates) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      attempts.push(`${name}: ${error.message.split('\n')[0]}`);
    }
  }
  throw collectionFailure(
    'no browser opened. Tried:\n  - ' +
      attempts.join('\n  - ') +
      '\nFix: npx playwright install chromium, or point MOBILE_GATE_BROWSER at a Chrome binary.',
  );
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

/**
 * Static HTTP server over `root`, on an ephemeral port.
 *
 * It exists because measuring a site through `file://` does not measure the
 * site: HTML that links `/assets/css/site.css` (an ABSOLUTE path) resolves to
 * the disk root under file:// and gets nothing. Pages with external CSS were
 * measured WITHOUT STYLE and reported defects that did not exist. Under
 * http:// the root is the published folder, as on the real host.
 */
export function startStaticServer(root) {
  const base = resolve(root);

  const server = createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('invalid url');
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // The audit reads files from disk: without this guard an audited page
    // could reach anything on the machine, .env included.
    const target = resolve(base, '.' + normalize(urlPath).replace(/\\/g, '/'));
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403).end('outside root');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  });

  return new Promise((ok, failed) => {
    server.on('error', failed);
    // 127.0.0.1 and not 0.0.0.0: the audit server stays off the local network.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      ok({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * The one device this tool calls "phone". One place only: a raw
 * `browser.newPage()` (no `isMobile`, so no respect for the viewport meta) and
 * an emulated context are two different devices fighting over the same word.
 */
export const DEVICE = {
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

/** How long to wait for fonts/CSS before giving up on the collection. */
export const RESOURCE_TIMEOUT_MS = 15_000;

/**
 * Opens `url` and returns the tab ready to MEASURE (or to screenshot).
 *
 * Single seam for settling: a checker and a screenshot tool need to look at
 * the same instant of the same page, otherwise the picture does not show what
 * the number says.
 *
 * `document.fonts.ready` is NOT proof that the font arrived: measured, with
 * the font host aborted it resolves all the same and `document.fonts.check()`
 * still returns true, and then a button measures 41px (violates 44px) instead
 * of 45px (passes). That lie made a report swing between 160 and 159
 * violations from run to run.
 *
 * The NETWORK knows whether the font arrived. So the proof is watching the
 * `font` and `stylesheet` requests: any that fails or returns >=400 sinks the
 * collection (exit 2). Measuring with the fallback is measuring another site.
 */
export async function openMeasurablePage(
  browser,
  url,
  { timeoutMs = RESOURCE_TIMEOUT_MS, fontsCss = null } = {},
) {
  const context = await browser.newContext(DEVICE);
  const tab = await context.newPage();
  const close = () => context.close();

  const blocking = (req) => req.resourceType() === 'font' || req.resourceType() === 'stylesheet';
  const failures = [];
  const pending = new Set();
  const servedFonts = [];
  const loadedFontsCss = { ok: false };
  // An image that did not load does NOT sink the collection (the page
  // rendered; the hole is the defect). So it lives outside `failures`, which
  // is exit 2 material.
  const brokenAssets = [];
  const isImage = (req) => req.resourceType() === 'image';

  tab.on('request', (req) => {
    if (blocking(req)) pending.add(req);
  });
  tab.on('requestfinished', (req) => pending.delete(req));
  tab.on('requestfailed', (req) => {
    pending.delete(req);
    if (blocking(req)) {
      failures.push(`${req.resourceType()} ${req.url()} (${req.failure()?.errorText ?? 'no reason'})`);
    }
    if (isImage(req)) {
      brokenAssets.push({
        url: req.url(),
        status: 0,
        type: 'image',
        detail: req.failure()?.errorText ?? 'request failed',
      });
    }
  });
  tab.on('response', (res) => {
    if (blocking(res.request()) && res.status() >= 400) {
      failures.push(`${res.request().resourceType()} ${res.url()} (HTTP ${res.status()})`);
    }
    if (res.request().resourceType() === 'font' && res.status() === 200) {
      servedFonts.push(res.url());
    }
    if (fontsCss && res.url().includes(fontsCss) && res.status() === 200) {
      loadedFontsCss.ok = true;
    }
    if (isImage(res.request()) && res.status() >= 400) {
      brokenAssets.push({ url: res.url(), status: res.status(), type: 'image' });
    }
  });

  try {
    // The DOCUMENT status has to be checked by hand: `blocking` only looks at
    // font/stylesheet, and Playwright's goto resolves normally on 404/500.
    // Without this, an error page is measured as if it were the page, and
    // since an error page has neither the viewport meta nor the real targets
    // and texts, the gate reports FEWER violations than exist. One run gave
    // 436 instead of 449 that way, with no sign of failure. A gate that errs
    // toward green is worse than no gate.
    const response = await tab.goto(url, { waitUntil: 'load' });
    if (!response) {
      throw collectionFailure(`no HTTP response for ${url}`);
    }
    if (response.status() >= 400) {
      throw collectionFailure(
        `the document answered HTTP ${response.status()} at ${url}: the measurement would be ` +
          `of the error page, not of the page`,
      );
    }

    // Font/CSS queue empty before any measurement.
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (pending.size > 0) {
      const stuck = [...pending].map((r) => r.url()).join(', ');
      throw collectionFailure(`font/CSS did not arrive in ${timeoutMs}ms: ${stuck}`);
    }
    if (failures.length > 0) {
      throw collectionFailure(
        `the page did not load its fonts/CSS, so the measurement would be of another site: ${failures.join('; ')}`,
      );
    }

    // Only now let it settle: font applied, two frames, entrance animation done.
    await tab.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => setTimeout(r, 400));
    });

    // Positive side of the same proof, from the SAME source of truth: the
    // network. Above we only report a font that FAILED; absence of failure is
    // also the picture of a page that requested no font at all and measured
    // the system fallback in silence. A page that serves the declared font
    // stylesheet has to download at least one face.
    if (loadedFontsCss.ok && servedFonts.length === 0) {
      throw collectionFailure(
        `the page links ${fontsCss} and downloaded no font face: either the CSS did not apply, ` +
          'or no declared family is used. Measuring this would be measuring the system fallback',
      );
    }

    // `network` is the half of the snapshot only the NETWORK knows: the DOM
    // cannot tell a 404 <img> from one never requested, nor a <link> that
    // arrived from one that broke. collectSnapshots() joins the two halves.
    return { tab, close, network: { loadedFontsCss: loadedFontsCss.ok, brokenAssets } };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * @param {string[]} pages paths relative to `root`
 * @param {{launcher: Function, root: string, fontsCss?: string|null}} deps
 */
export async function collectSnapshots(pages, { launcher, root = '_site', fontsCss = null } = {}) {
  let browser;
  try {
    browser = await launcher();
  } catch (error) {
    throw collectionFailure(
      `the browser did not start (${error.message}). Fix: npx playwright install chromium`,
      error,
    );
  }

  let server;
  try {
    server = await startStaticServer(root);
  } catch (error) {
    await browser.close();
    throw collectionFailure(`the static server did not start on ${root} (${error.message})`, error);
  }

  const snapshots = [];
  try {
    for (const page of pages) {
      const url = `${server.origin}/${page.split(sep).join('/')}`;
      let session;
      try {
        session = await openMeasurablePage(browser, url, { fontsCss });
        const raw = await session.tab.evaluate(pageSnapshot, VIEWPORT);
        snapshots.push({ page, ...raw, ...session.network });
      } catch (error) {
        throw collectionFailure(`the page ${page} could not be inspected (${error.message})`, error);
      } finally {
        if (session) await session.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  return snapshots;
}

/** Byte ceiling for a file to be mistaken for a verification token. */
const MAX_TOKEN_BYTES = 512;

/**
 * An .html file that is not a page: a site ownership verification token.
 *
 * Measured: a `no-viewport-meta=1` in the gate was a `google<hash>.html`, 53
 * bytes, one line `google-site-verification: google<hash>.html`. Search
 * Console requires that file with that content; stuffing a viewport meta into
 * it would deform a third party artifact to please the meter.
 *
 * Recognition is by CONTENT and not by name (`google*.html` would match a real
 * page called `google-ads.html`). The three conditions together (tiny, one
 * line, and the whole line being `<something>-site-verification: <value>`
 * without a single tag) do not exist in a renderable page. Bing, Yandex and
 * Facebook use the same format, hence the generic prefix.
 *
 * Whoever ignores a file cannot ignore it in silence: the CLI prints the list.
 */
export function isVerificationToken(text) {
  if (typeof text !== 'string' || text.length > MAX_TOKEN_BYTES) return false;
  if (/[<>]/.test(text)) return false;
  return /^[a-z0-9-]+-site-verification:\s*\S+$/i.test(text.trim());
}

/**
 * Recursively lists the .html files of `root`, in stable order.
 * Pushes into `ignored` (when given) what was left out and why.
 */
export function listPublishedPages(root, { ignored } = {}) {
  if (!existsSync(root)) {
    throw collectionFailure(`${root}/ does not exist. Fix: build the site first`);
  }
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.html')) continue;
      const rel = relative(root, path).split(sep).join('/');
      const info = statSync(path);
      if (info.size <= MAX_TOKEN_BYTES && isVerificationToken(readFileSync(path, 'utf8'))) {
        ignored?.push({ page: rel, reason: 'site ownership verification token, not a page' });
        continue;
      }
      found.push(rel);
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatReport({ ok, errors, pages }) {
  if (ok) {
    return `mobile OK: ${pages} page(s) checked at ${VIEWPORT.width}x${VIEWPORT.height}, no invariant violated`;
  }
  const lines = errors.map((e) => `  ${e.page}\n    [${e.reason}] ${e.detail}`);
  const byReason = new Map();
  for (const e of errors) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  const summary = [...byReason].map(([r, n]) => `${r}=${n}`).join(' ');
  return [
    `mobile FAIL: ${errors.length} violation(s) in ${pages} page(s) checked ` +
      `(${VIEWPORT.width}x${VIEWPORT.height})`,
    `summary: ${summary}`,
    '',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node check-mobile.mjs [folder] [options]

  folder                   the published folder to check (default: _site)

  --fonts-css=<url path>   require every page to load this font stylesheet,
                           e.g. --fonts-css=/assets/css/fonts.css
  --font-canon=<a,b,c>     require every computed font-family to stay inside
                           this comma separated list
  --exempt-prefix=<a,b>    page path prefixes exempt from the two typography
                           options above, e.g. --exempt-prefix=work/

exit codes: 0 all invariants passed, 1 violation found, 2 collection did not run`;

const csv = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Pure, so a typo in a flag is a collection failure and never a silent green. */
export function parseArgs(argv) {
  const parsed = { root: null, help: false, fontsCss: null, fontCanon: null, exemptPrefixes: [] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--fonts-css=')) parsed.fontsCss = arg.slice('--fonts-css='.length) || null;
    else if (arg.startsWith('--font-canon=')) parsed.fontCanon = csv(arg.slice('--font-canon='.length));
    else if (arg.startsWith('--exempt-prefix=')) parsed.exemptPrefixes = csv(arg.slice('--exempt-prefix='.length));
    else if (arg.startsWith('-')) throw collectionFailure(`unknown option ${arg}\n\n${USAGE}`);
    else if (parsed.root === null) parsed.root = arg;
    else throw collectionFailure(`unexpected argument ${arg}\n\n${USAGE}`);
  }
  if (parsed.fontCanon && parsed.fontCanon.length === 0) {
    throw collectionFailure('--font-canon was given an empty list');
  }
  parsed.root ??= '_site';
  return parsed;
}

async function main() {
  try {
    const { root, help, fontsCss, fontCanon, exemptPrefixes } = parseArgs(process.argv.slice(2));
    if (help) {
      console.log(USAGE);
      return 0;
    }
    const ignored = [];
    const pages = listPublishedPages(root, { ignored });
    for (const { page, reason } of ignored) console.log(`ignored: ${page} (${reason})`);
    const { chromium } = await import('playwright-core').catch((error) => {
      throw collectionFailure(
        `the playwright-core package is not available (${error.message}). Fix: npm ci`,
        error,
      );
    });
    const snapshots = await collectSnapshots(pages, {
      launcher: () => launchBrowser(chromium),
      root,
      fontsCss,
    });
    const result = evaluateMobile(snapshots, { fontsCss, fontCanon, exemptPrefixes });
    console.log(formatReport(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.isCollectionFailure ? error.message : `COLLECTION FAILURE: ${error.message}`);
    return 2;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
