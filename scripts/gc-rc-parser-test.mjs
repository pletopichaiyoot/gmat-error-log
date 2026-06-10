// Test the new gmatClubEnrichCurrentPage RC + single-question paths.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
page.on('dialog', async (d) => { try { await d.dismiss(); } catch {} });

const SCRIPT = readFileSync('./src/scrapers/gmat_club_question_scraper.js', 'utf8');

const URLS = [
  ['https://gmatclub.com/forum/topic455064.html', 'CR single'],
  ['https://gmatclub.com/forum/topic59802.html', 'RC 6Q'],
  ['https://gmatclub.com/forum/topic176177.html', 'RC 6Q (parens)'],
  ['https://gmatclub.com/forum/topic136859.html', 'RC 5Q'],
];

for (const [url, label] of URLS) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.addScriptTag({ content: SCRIPT });
  const result = await page.evaluate(() => window.gmatClubEnrichCurrentPage());
  console.log(`\n======== ${label} ${url} ========`);
  console.log('layout:', result.layout, 'ok:', result.ok);
  if (result.layout === 'rc') {
    console.log('passage chars:', (result.passage || '').length);
    console.log('passage head:', (result.passage || '').slice(0, 280).replace(/\n/g, ' / '));
    console.log('question count:', result.questions.length);
    for (const q of result.questions.slice(0, 2)) {
      console.log(`  Q${q.position}: correct=${q.correct_answer} mine=${q.my_answer} stem="${(q.stem || '').slice(0, 110)}"`);
      for (const c of q.choices) console.log(`    ${c.label}: ${c.text.slice(0, 90)}`);
    }
  } else {
    console.log('stem:', (result.stem || '').slice(0, 200));
    console.log('correct:', result.correct_answer, 'mine:', result.my_answer);
    console.log('choices:', result.choices?.length || 0);
    for (const c of (result.choices || [])) console.log(`  ${c.label}: ${(c.text || '').slice(0, 90)}`);
  }
}

await page.close();
await browser.close();
