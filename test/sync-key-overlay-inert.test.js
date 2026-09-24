'use strict';
/* Regression guard for a review finding: #sync-key-overlay has
   role="dialog"/aria-modal="true", but aria-modal is only a hint for
   assistive tech — it doesn't itself stop Tab (or a click) from reaching
   elements behind the overlay. renderer/app.js must mark #app (the
   overlay's only sibling in index.html) `inert` while the overlay is open,
   and clear it again on dismiss, so a keyboard user can never tab into —
   or a click never reaches — the app behind it.

   There's no jsdom/browser engine here (see test/renderer-css.test.js's
   own comment for why), so this checks the source directly rather than
   exercising the DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('opening the overlay marks #app inert', () => {
  assert.match(
    appJs,
    /getElementById\('app'\)\.inert = true/,
    'showing #sync-key-overlay must set #app.inert = true so Tab/click cannot reach the app behind it'
  );
});

test('dismiss() clears #app.inert again', () => {
  assert.match(
    appJs,
    /getElementById\('app'\)\.inert = false/,
    "dismiss() must clear #app.inert so the app behind the overlay is reachable again once it's closed"
  );
});

test('#sync-key-overlay is a sibling of #app, not nested inside it', () => {
  // Marking #app inert must never make the overlay itself inert — that
  // only holds if the overlay lives outside #app's subtree.
  const appOpenIndex = indexHtml.indexOf('<div id="app">');
  const overlayAttrIndex = indexHtml.indexOf('id="sync-key-overlay"');
  assert.ok(appOpenIndex >= 0, '#app must exist');
  assert.ok(overlayAttrIndex >= 0, '#sync-key-overlay must exist');
  assert.ok(overlayAttrIndex > appOpenIndex, '#sync-key-overlay must come after #app opens');
  // The overlay's own opening `<div` (its attributes, including
  // `id="sync-key-overlay"`, are on the following lines) must be
  // excluded from the slice below — otherwise it counts as one more
  // unmatched open that has nothing to do with whether #app itself is
  // closed by this point.
  const overlayDivStart = indexHtml.lastIndexOf('<div', overlayAttrIndex);
  const between = indexHtml.slice(appOpenIndex, overlayDivStart);
  const opens = (between.match(/<div/g) || []).length;
  const closes = (between.match(/<\/div>/g) || []).length;
  assert.equal(
    opens,
    closes,
    '#app must be fully closed (equal <div>/</div> count) before #sync-key-overlay starts'
  );
});
