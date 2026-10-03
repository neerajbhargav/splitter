import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_MAX_TOKENS, DEFAULT_MODELS, HISTORY_TURNS, buildRequest, clearAiConfig, keyHint, loadAiConfig, maskKey,
  normalizeConfig, parseResponse, prepareMessages, saveAiConfig, systemPrompt,
} from '../src/lib/finance-ai.ts';
import type { AiConfig, ChatTurn } from '../src/lib/finance-ai.ts';
import { AI_SYSTEM_PROMPT } from '../src/lib/finance-insights.ts';

const SYSTEM = systemPrompt('Today: 2026-10-01\nCurrency: USD');
const Q: ChatTurn[] = [{ role: 'user', content: 'Can I afford a $420 car payment?' }];
const cfg = (provider: AiConfig['provider'], model = ''): AiConfig => ({ provider, key: '  sk-test-1234567890abcd  ', model });
const body = (init: RequestInit) => JSON.parse(String(init.body));
const headers = (init: RequestInit) => init.headers as Record<string, string>;

test('system prompt appends the ledger after the shared prompt', () => {
  assert.equal(SYSTEM, `${AI_SYSTEM_PROMPT}\n\nLedger:\nToday: 2026-10-01\nCurrency: USD`);
});

test('openrouter request: bearer, referer, title, system first, default model', () => {
  const { url, init } = buildRequest(cfg('openrouter'), SYSTEM, Q);
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.method, 'POST');
  const h = headers(init);
  assert.equal(h.Authorization, 'Bearer sk-test-1234567890abcd');
  assert.equal(h['HTTP-Referer'], 'https://usesplitter.vercel.app');
  assert.equal(h['X-Title'], 'SPLITTER');
  assert.equal(h['Content-Type'], 'application/json');
  const b = body(init);
  assert.equal(b.model, DEFAULT_MODELS.openrouter);
  assert.equal(b.model, 'openai/gpt-4.1-mini');
  assert.deepEqual(b.messages, [{ role: 'system', content: SYSTEM }, ...Q]);
});

test('openai request: bearer only, model override, no openrouter headers', () => {
  const { url, init } = buildRequest(cfg('openai', ' gpt-4o '), SYSTEM, Q);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  const h = headers(init);
  assert.equal(h.Authorization, 'Bearer sk-test-1234567890abcd');
  assert.equal(h['HTTP-Referer'], undefined);
  assert.equal(h['X-Title'], undefined);
  const b = body(init);
  assert.equal(b.model, 'gpt-4o');
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.max_tokens, undefined);
});

test('anthropic request: x-api-key, version, browser header, system separate, max_tokens', () => {
  const { url, init } = buildRequest(cfg('anthropic'), SYSTEM, Q);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  const h = headers(init);
  assert.equal(h['x-api-key'], 'sk-test-1234567890abcd');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(h.Authorization, undefined);
  const b = body(init);
  assert.equal(b.model, 'claude-sonnet-4-5');
  assert.equal(b.max_tokens, ANTHROPIC_MAX_TOKENS);
  assert.equal(b.max_tokens, 900);
  assert.equal(b.system, SYSTEM);
  assert.deepEqual(b.messages, Q);
  assert.ok(b.messages.every((m: ChatTurn) => m.role !== ('system' as string)));
});

test('anthropic model override is used', () => {
  assert.equal(body(buildRequest(cfg('anthropic', 'claude-opus-4-1'), SYSTEM, Q).init).model, 'claude-opus-4-1');
});

test('history keeps the last 8 turns plus the new question', () => {
  const long: ChatTurn[] = [];
  for (let i = 0; i < 20; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  long.push({ role: 'user', content: 'latest' });
  // 21 messages ending user/latest: last 9 are m12..m19 + latest, m12 is user.
  for (const p of ['openrouter', 'openai', 'anthropic'] as const) {
    const msgs = body(buildRequest(cfg(p), SYSTEM, long).init).messages as ChatTurn[];
    const turns = msgs.filter((m) => m.role !== ('system' as string));
    assert.equal(turns.length, HISTORY_TURNS + 1);
    assert.equal(turns[0].content, 'm12');
    assert.equal(turns.at(-1)!.content, 'latest');
  }
});

test('truncation never starts on an assistant turn', () => {
  const msgs: ChatTurn[] = [];
  for (let i = 0; i < 9; i++) msgs.push({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
  msgs.push({ role: 'user', content: 'q' });
  const out = prepareMessages(msgs);
  assert.equal(out[0].role, 'user');
  assert.equal(out.at(-1)!.content, 'q');
});

test('back-to-back user turns (a failed answer) are merged and blanks dropped', () => {
  const out = prepareMessages([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'second' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'first\n\nsecond' }]);
});

test('buildRequest rejects missing key or empty conversation', () => {
  assert.throws(() => buildRequest({ provider: 'openai', key: '  ', model: '' }, SYSTEM, Q), /API key/);
  assert.throws(() => buildRequest(cfg('openai'), SYSTEM, []), /question/);
});

test('parse openai / openrouter answers', () => {
  const ok = { choices: [{ message: { role: 'assistant', content: '  Yes, it fits.  ' } }] };
  assert.equal(parseResponse('openai', ok), 'Yes, it fits.');
  assert.equal(parseResponse('openrouter', ok), 'Yes, it fits.');
  assert.equal(parseResponse('openrouter', { choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }] }), 'AB');
});

test('parse anthropic answers, joining text blocks only', () => {
  const json = { type: 'message', content: [{ type: 'text', text: 'Verdict: tight.' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: ' Cut dining.' }] };
  assert.equal(parseResponse('anthropic', json), 'Verdict: tight. Cut dining.');
});

test('provider error payloads surface their message', () => {
  assert.throws(() => parseResponse('openai', { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }), /OpenAI: Incorrect API key provided/);
  assert.throws(() => parseResponse('openrouter', { error: { code: 402, message: 'Insufficient credits' } }), /OpenRouter: Insufficient credits/);
  assert.throws(() => parseResponse('openrouter', { choices: [{ error: { message: 'Upstream timeout' } }] }), /OpenRouter: Upstream timeout/);
  assert.throws(() => parseResponse('anthropic', { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), /Anthropic: invalid x-api-key/);
});

test('empty or unreadable content is an error, not a blank bubble', () => {
  assert.throws(() => parseResponse('openai', { choices: [{ message: { content: '' } }] }), /empty answer/);
  assert.throws(() => parseResponse('openai', { choices: [] }), /empty answer/);
  assert.throws(() => parseResponse('anthropic', { content: [] }), /empty answer/);
  assert.throws(() => parseResponse('anthropic', null), /couldn't read/);
});

test('refusals are shown as the answer', () => {
  assert.equal(parseResponse('openai', { choices: [{ message: { content: null, refusal: 'I can not help with that.' } }] }), 'I can not help with that.');
});

test('key masking shows first 4 and last 4 only', () => {
  assert.equal(maskKey('sk-or-v1-abcdef1234567890'), 'sk-o…7890');
  assert.equal(maskKey('  sk-ant-api03-XYZ-9f3a  '), 'sk-a…9f3a');
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey('12345678901'), '••••••••');
  assert.ok(!maskKey('sk-or-v1-abcdef1234567890').includes('abcdef'));
});

test('key hints catch keys pasted under the wrong provider', () => {
  assert.equal(keyHint('openrouter', 'sk-or-v1-abc'), null);
  assert.equal(keyHint('anthropic', 'sk-ant-abc'), null);
  assert.equal(keyHint('openai', 'sk-proj-abc'), null);
  assert.match(keyHint('openai', 'sk-ant-abc')!, /Anthropic/);
  assert.match(keyHint('anthropic', 'sk-or-v1')!, /OpenRouter/);
  assert.match(keyHint('openrouter', 'sk-proj-abc')!, /sk-or-/);
  assert.equal(keyHint('openai', ''), null);
});

test('config normalizes and storage is safe outside the browser', () => {
  assert.deepEqual(normalizeConfig({ provider: 'openai', key: ' k ', model: ' ' }), { provider: 'openai', key: 'k', model: 'gpt-4.1-mini' });
  assert.equal(normalizeConfig({ provider: 'gemini', key: 'k' }), null);
  assert.equal(normalizeConfig({ provider: 'openai', key: '' }), null);
  assert.equal(loadAiConfig(), null);
  assert.doesNotThrow(() => clearAiConfig());
  assert.throws(() => saveAiConfig({ provider: 'openai', key: 'sk-abc', model: '' }), /local storage/);
});

test('storage round trip with a fake localStorage', () => {
  const mem = new Map<string, string>();
  const fake = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const g = globalThis as { localStorage?: unknown; window?: unknown };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  g.window = globalThis;
  try {
    saveAiConfig({ provider: 'anthropic', key: ' sk-ant-1 ', model: '' });
    assert.deepEqual(JSON.parse(mem.get('splitter-finance-ai')!), { provider: 'anthropic', key: 'sk-ant-1', model: 'claude-sonnet-4-5' });
    assert.deepEqual(loadAiConfig(), { provider: 'anthropic', key: 'sk-ant-1', model: 'claude-sonnet-4-5' });
    mem.set('splitter-finance-ai', '{not json');
    assert.equal(loadAiConfig(), null);
    clearAiConfig();
    assert.equal(mem.size, 0);
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete g.localStorage;
    delete g.window;
  }
});
