import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import { parseSavedCookieStringForAddCookies } from '../examples/utils.ts';

test('saved NotebookLM cookie strings normalize to Playwright addCookies-compatible cookies', async () => {
  const cookies = parseSavedCookieStringForAddCookies(
    'SID=value=with=equals; bad�=skip; keep=bad�; __Host-GAPS=host-value; ; tail=value;'
  );

  assert.deepEqual(cookies.map(cookie => cookie.name), ['SID', '__Host-GAPS', 'tail']);
  assert.equal(cookies.find(cookie => cookie.name === 'SID')?.value, 'value=with=equals');

  for (const cookie of cookies) {
    assert.ok(cookie.url || cookie.path);
    assert.ok(!(cookie.url && cookie.path));
    assert.ok(!(cookie.url && cookie.domain));
    if (cookie.domain) {
      assert.equal(cookie.domain.startsWith('.'), false);
    }
  }

  const hostCookie = cookies.find(cookie => cookie.name === '__Host-GAPS');
  assert.equal(hostCookie?.url, 'https://notebooklm.google.com/');
  assert.equal(hostCookie?.domain, undefined);
  assert.equal(hostCookie?.path, undefined);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    try {
      await context.addCookies(cookies);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
