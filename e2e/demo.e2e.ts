// Drives the built demo (docs/index.html) in a real headless browser.
// Uses the Chrome or Edge already on this machine, so nothing big is downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';

async function launch(): Promise<Browser> {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel });
    } catch { /* try the next one */ }
  }
  throw new Error('No Chrome or Edge found. Install one, or run: npx playwright install chromium');
}

test('the demo: full merge flow, no console errors, phone, dark mode, keyboard, reduced motion', async (t) => {
  const html = await readFile('docs/index.html');
  // Served over http, the way GitHub Pages serves it, rather than as a file:// URL.
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });

  const problems: string[] = [];
  const open = async (opts: Parameters<Browser['newPage']>[0] = {}): Promise<Page> => {
    const page = await browser.newPage(opts);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(url);
    await page.waitForSelector('[data-lane="merge"]');
    return page;
  };
  const cards = (page: Page) => page.locator('.card');

  const page = await open({ viewport: { width: 1280, height: 900 } });

  // The example edits load: 3 questions, one of each kind.
  await assert.doesNotReject(page.getByText('Ripple delete "Point 2" (with "Laptop b-roll"): 4 clips moved −10s').waitFor());
  assert.equal(await cards(page).count(), 3);
  assert.equal(await page.locator('#save').isDisabled(), true);
  // Grain survives the move: Point 3 in the merge lane still has grain.
  assert.equal(await page.locator('[data-lane="merge"] [data-clip="p3"].fx').count(), 1);
  // Merged-by-itself notes are there.
  await page.getByText('Moved new clip "Three things we learned" −1s to stay with "Point 3"').waitFor();

  // Keep the laptop: two new overlaps appear, marked as new.
  await page.getByRole('button', { name: 'Keep Rahul’s edited version' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  assert.equal(await page.locator('.badge', { hasText: 'appeared after your last choice' }).count(), 2);

  // Answer everything: Rahul's title, then "make room" until nothing is left.
  await page.getByRole('button', { name: /Keep Rahul’s: “Launch week 2026”/ }).click();
  for (let i = 0; i < 10 && (await cards(page).count()) > 0; i++) {
    await page.locator('.card button', { hasText: 'Make room' }).first().click();
    await page.waitForTimeout(50);
  }
  assert.equal(await cards(page).count(), 0);
  assert.ok((await page.locator('.plain li', { hasText: 'Change' }).count()) >= 4);

  // Save to main: a merge commit shows up in the history.
  await page.locator('#save').click();
  await page.getByText(/Saved to main as/).waitFor();
  assert.ok((await page.locator('.log .merge').count()) >= 1);

  // A real edit on a branch: select a clip, add grain, see the sentence.
  await page.locator('[data-lane="aditi"] [data-clip="city"]').click();
  await page.locator('.panel.aditi .toolbar').getByRole('button', { name: 'Grain' }).click();
  await page.getByText('Effects on "City b-roll": added grain').waitFor();
  // An edit that would overlap is refused with a clear message.
  await page.getByRole('button', { name: 'Start over' }).click();
  await page.locator('[data-lane="rahul"] [data-clip="laptop"]').click();
  for (let i = 0; i < 12; i++) await page.locator('.panel.rahul .toolbar').getByRole('button', { name: 'Move one second later' }).click();
  await page.locator('.panel.rahul .status', { hasText: 'would overlap' }).waitFor();

  // Keyboard: focus is visible.
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  assert.notEqual(outline, 'none');

  // Phone: no sideways page scroll (the lanes scroll inside their own box).
  const phone = await open({ viewport: { width: 375, height: 800 }, isMobile: true });
  const [sw, cw] = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw <= cw, `page is ${sw}px wide on a ${cw}px screen`);

  // Dark theme and reduced motion.
  const dark = await open({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(21, 20, 15)');
  const transition = await dark.evaluate(() => getComputedStyle(document.querySelector('.clip')!).transitionDuration);
  assert.equal(transition, '0s');

  // The in-browser benchmark runs.
  await dark.getByRole('button', { name: 'Run the 5,000-clip benchmark here' }).click();
  await dark.locator('.bench table').waitFor({ timeout: 60_000 });

  assert.deepEqual(problems, []);
});
