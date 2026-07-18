'use strict';
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeStimulusHtml } = require('../../src/scrapers/ope-stem.js');

test('keeps svg, table, and data: images', () => {
  const out = sanitizeStimulusHtml('<div><svg><rect x="1"/></svg><table><tr><td>2.0</td></tr></table><img src="data:image/png;base64,AAA"></div>');
  assert.ok(out.includes('<svg'), 'svg kept');
  assert.ok(out.includes('<table'), 'table kept');
  assert.ok(out.includes('data:image/png'), 'data image kept');
});

test('strips scripts, event handlers, and external src', () => {
  const out = sanitizeStimulusHtml('<svg onload="alert(1)"><script>x()</script></svg><img src="https://evil/x.png">');
  assert.ok(!/onload/i.test(out), 'onload stripped');
  assert.ok(!/<script/i.test(out), 'script stripped');
  assert.ok(!/https:\/\/evil/.test(out), 'external src stripped');
});
