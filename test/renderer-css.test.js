'use strict';
/* Regression guard for a review finding: renderer/app.css gave #auth-panel
   and #auth-form `display: flex`, which overrides the browser's built-in
   `[hidden] { display: none }` (a page's own CSS always beats that
   default) — so the `hidden` attribute on those two elements in
   index.html did nothing. With sync not configured (the default), the
   header showed the sign-in form; while pending or signed in, the form
   stayed visible next to "CHECK YOUR INBOX" or "SYNCED AS".

   There's no DOM/CSS engine available under node:test (no jsdom in this
   project), so this can't exercise the actual cascade — it just asserts
   the override rule that fixes it is present in the stylesheet, so a
   future edit can't silently drop it again. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.css'), 'utf8');

test('app.css overrides [hidden] back to display:none for #auth-panel and #auth-form', () => {
  assert.match(
    css,
    /#auth-panel\[hidden\][\s\S]{0,80}display:\s*none/,
    '#auth-panel[hidden] must resolve to display:none — its bare rule sets display:flex, ' +
      'which beats the browser default [hidden] { display:none }'
  );
  assert.match(
    css,
    /#auth-form\[hidden\][\s\S]{0,80}display:\s*none/,
    '#auth-form[hidden] must resolve to display:none — its bare rule sets display:flex, ' +
      'which beats the browser default [hidden] { display:none }'
  );
});

test('app.css overrides [hidden] back to display:none for #sync-key-overlay', () => {
  // Same class of bug as #auth-panel/#auth-form above: #sync-key-overlay's
  // bare rule sets display:flex (to center its card), which beats the
  // browser's built-in `[hidden] { display: none }` unless overridden.
  assert.match(
    css,
    /#sync-key-overlay\[hidden\][\s\S]{0,80}display:\s*none/,
    '#sync-key-overlay[hidden] must resolve to display:none — its bare rule sets display:flex, ' +
      'which beats the browser default [hidden] { display:none }'
  );
});
