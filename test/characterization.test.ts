import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { saveCredentials } from '../src/auth/auth.ts';
import { parseAuthToken } from '../src/auth/refresh.ts';
import {
  formatReportAsHTML,
  formatReportAsJSON,
  formatReportAsMarkdown,
  formatReportAsText,
  ArtifactsService,
} from '../src/services/artifacts.ts';
import { ArtifactType } from '../src/types/artifact.ts';
import {
  getLanguageInfo,
  isLanguageSupported,
  NotebookLMLanguage,
} from '../src/types/languages.ts';
import { APIError, getErrorCode, isErrorResponse } from '../src/utils/errors.ts';
import { parseChunkedResponse } from '../src/utils/chunked-decoder.ts';
import { createChunkedParser } from '../src/utils/chunked-parser.ts';
import { QuotaManager, validateFileSize, validateTextSource } from '../src/utils/quota.ts';
import { resolveTransportLocaleSettings } from '../src/utils/locale.ts';
import { StreamingClient } from '../src/utils/streaming-client.ts';

test('error helpers preserve success and error code behavior', () => {
  assert.equal(isErrorResponse({ data: 0 }), null);
  assert.equal(isErrorResponse({ data: 1 }), null);
  assert.equal(isErrorResponse({ data: [0] }), null);
  assert.equal(isErrorResponse({ data: [1] }), null);

  const unavailable = getErrorCode(14);
  assert.equal(unavailable?.message, 'Unavailable');
  assert.equal(unavailable?.retryable, true);

  const resourceError = isErrorResponse({ data: 8 });
  assert.ok(resourceError instanceof APIError);
  assert.equal(resourceError.errorCode?.message, 'Resource exhausted');
});

test('parseAuthToken splits token value and applies one hour expiry', () => {
  const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0);
  const parsed = parseAuthToken(`token-value:${timestamp}`);

  assert.equal(parsed.tokenValue, 'token-value');
  assert.equal(parsed.expiryTime.toISOString(), '2026-01-01T01:00:00.000Z');
  assert.throws(() => parseAuthToken('missing-timestamp'));
  assert.throws(() => parseAuthToken('token:not-a-number'));
});

test('saveCredentials writes credentials.json with owner-only permissions', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'notebooklm-kit-test-'));

  try {
    process.chdir(dir);
    await saveCredentials({ authToken: 'token', cookies: 'cookie=value' });
    const fileStat = await stat(join(dir, 'credentials.json'));
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('locale resolution preserves config, env, system, and default precedence', () => {
  assert.deepEqual(resolveTransportLocaleSettings({
    requestedLocale: 'ja_JP.UTF-8',
    env: { NOTEBOOKLM_LOCALE: 'fr-FR', LANG: 'de_DE.UTF-8' },
  }), {
    effectiveLocale: 'ja-JP',
    localeSource: 'config',
    hl: 'ja',
    acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
  });

  assert.equal(resolveTransportLocaleSettings({
    requestedLocale: 'auto',
    env: { NOTEBOOKLM_LOCALE: 'fr_CA.UTF-8', LANG: 'de_DE.UTF-8' },
  }).localeSource, 'env');

  assert.deepEqual(resolveTransportLocaleSettings({
    env: { LC_ALL: 'de_DE.UTF-8' },
  }), {
    effectiveLocale: 'de-DE',
    localeSource: 'system',
    hl: 'de',
    acceptLanguage: 'de-DE,de;q=0.9,en-US;q=0.6,en;q=0.5',
  });

  assert.deepEqual(resolveTransportLocaleSettings({ env: {} }), {
    effectiveLocale: 'en-US',
    localeSource: 'default',
    hl: 'en',
    acceptLanguage: 'en-US,en;q=0.9',
  });
});

test('quota helpers enforce current standard-plan limits', () => {
  validateTextSource('one two three');
  validateFileSize(200 * 1024 * 1024);
  assert.throws(() => validateTextSource(`${'word '.repeat(500001)}`), APIError);
  assert.throws(() => validateFileSize(200 * 1024 * 1024 + 1), APIError);

  const quota = new QuotaManager(true, 'standard');
  for (let i = 0; i < 50; i += 1) {
    quota.recordUsage('chat');
  }
  assert.throws(() => quota.checkQuota('chat'), /Daily chat limit exceeded/);
});

test('artifact helpers preserve API type mapping, CSV, and report formatting', () => {
  const service = new ArtifactsService({} as any) as any;

  assert.equal(service.getApiTypeNumber(ArtifactType.AUDIO), 1);
  assert.equal(service.getApiTypeNumber(ArtifactType.REPORT), 2);
  assert.equal(service.getApiTypeNumber(ArtifactType.SLIDE_DECK), 8);
  assert.equal(service.mapApiTypeToArtifactType(8, []), ArtifactType.SLIDE_DECK);
  assert.equal(service.mapApiTypeToArtifactType(9, []), ArtifactType.DATA_TABLE);
  assert.equal(service.mapApiTypeToArtifactType(4, [[null, [null, null, null, null, null, null, null, [2]]]]), ArtifactType.QUIZ);
  assert.equal(service.mapApiTypeToArtifactType(4, [[null, [null, null, null, null, null, null, [2]]]]), ArtifactType.FLASHCARDS);

  assert.deepEqual(service.parseCSVLine('"Question, one","Answer ""quoted"""'), [
    'Question, one',
    'Answer "quoted"',
  ]);

  const report = {
    title: 'Daily Report',
    content: 'Summary <unsafe>',
    sections: [{ title: 'Next', content: 'Line 1\nLine 2' }],
  };
  assert.equal(formatReportAsMarkdown(report), '# Daily Report\n\nSummary <unsafe>\n\n## Next\n\nLine 1\nLine 2\n\n');
  assert.match(formatReportAsText(report), /Daily Report\n=+\n\nSummary <unsafe>/);
  assert.match(formatReportAsHTML(report), /Summary &lt;unsafe&gt;/);
  assert.equal(formatReportAsJSON(report), JSON.stringify(report, null, 2));
});

test('chunked decoders parse simple ASCII wrb.fr frames', () => {
  const frame = JSON.stringify([['wrb.fr', 'abc123', JSON.stringify(['hello']), null, null, null, 'generic']]);
  const raw = `${frame.length}\n${frame}`;
  assert.deepEqual(parseChunkedResponse(raw), [{
    index: 0,
    id: 'abc123',
    data: JSON.stringify(['hello']),
  }]);

  const projectId = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(createChunkedParser(JSON.stringify([[['Notebook', [], projectId, '📘', null]]])).parseListProjectsResponse(), [{
    projectId,
    title: 'Notebook',
    emoji: '📘',
    sourceCount: 0,
  }]);
});

test('streaming parseFrame parses simple ASCII frames without network', () => {
  const client = new StreamingClient({
    authToken: 'token',
    cookies: 'cookie=value',
  } as any) as any;
  const inner = JSON.stringify([['**Thinking** Hello [1]', null, ['conv', 'msg', 123], null, { bold: true }, null, null, null, 2]]);
  const frame = JSON.stringify([['wrb.fr', null, inner]]);

  const parsed = client.parseFrame(frame.length, frame);
  assert.equal(parsed.text, '**Thinking** Hello [1]');
  assert.deepEqual(parsed.thinking, ['Thinking']);
  assert.equal(parsed.response, ' Hello [1]');
  assert.deepEqual(parsed.metadata, ['conv', 'msg', 123]);
  assert.deepEqual(parsed.citations, [1]);
  assert.equal(parsed.errorCode, 2);
});

test('streamChat keeps interleaved streams isolated', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.push(controller);
    },
  }));
  let fetchCount = 0;

  globalThis.fetch = (async () => new Response(streams[fetchCount++])) as typeof fetch;

  try {
    const client = new StreamingClient({
      authToken: 'token',
      cookies: 'cookie=value',
    } as any);

    const buildWireFrame = (text: string): string => {
      const inner = JSON.stringify([[text, null, ['conv', text, 123], null, null, null, null, null, 2]]);
      const frame = JSON.stringify([['wrb.fr', null, inner]]);
      return `${frame.length}\n${frame}`;
    };

    const firstFrame = buildWireFrame('first');
    const secondFrame = buildWireFrame('second');
    const splitAt = firstFrame.indexOf('[[');

    const firstStream = client.streamChat('notebook', 'prompt-a', [], 'conversation-a', null);
    const secondStream = client.streamChat('notebook', 'prompt-b', [], 'conversation-b', null);
    const firstNext = firstStream.next();

    controllers[0].enqueue(encoder.encode(firstFrame.slice(0, splitAt)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondNext = secondStream.next();
    controllers[1].enqueue(encoder.encode(secondFrame));
    controllers[1].close();
    const secondResult = await secondNext;

    controllers[0].enqueue(encoder.encode(firstFrame.slice(splitAt)));
    controllers[0].close();
    const firstResult = await firstNext;

    assert.equal(firstResult.value?.text, 'first');
    assert.equal(secondResult.value?.text, 'second');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('language helpers preserve exact supported-code lookup behavior', () => {
  assert.equal(getLanguageInfo(NotebookLMLanguage.JAPANESE)?.nativeName, '日本語');
  assert.equal(isLanguageSupported('ja'), true);
  assert.equal(isLanguageSupported('JA'), false);
  assert.equal(isLanguageSupported('xx'), false);
});
