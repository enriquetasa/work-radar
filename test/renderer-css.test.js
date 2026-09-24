'use strict';
/* Regression guard: page CSS such as #auth-form { display: flex } overrides
   the browser's built-in [hidden] rule. The global author rule must use
   !important so hidden auth forms, modal overlays, and view controls remain
   hidden even when a more specific component selector sets display. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.css'), 'utf8');

test('hidden elements stay hidden despite component display rules', () => {
  assert.match(
    css,
    /(?:^|\})\s*\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/,
    'The global [hidden] rule needs display:none !important to beat component selectors'
  );
});
