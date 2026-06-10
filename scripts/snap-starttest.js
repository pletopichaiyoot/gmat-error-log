#!/usr/bin/env node
/* Snapshot the user's currently-open StartTest tab via CDP. */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  let target = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (/starttest\.com/i.test(url)) {
        target = p;
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    console.error('No starttest.com tab found.');
    process.exit(1);
  }
  console.log('Found tab:', target.url());
  const out = path.join(__dirname, '..', 'starttest-actual.png');
  await target.screenshot({ path: out, fullPage: false });
  console.log('Wrote', out);
  // Also dump some structural info
  const info = await target.evaluate(() => ({
    title: document.title,
    iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ id: f.id, src: f.src })),
    bodyClass: document.body.className,
  }));
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
