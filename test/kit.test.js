import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, JevError, resolveKey } from '../src/client.js';
import * as tools from '../src/tools.js';
import { handle, listTools } from '../src/mcp.js';
import { startMock } from './mock.js';

const mk = async (opts) => {
  const mock = await startMock(opts);
  const client = createClient({ apiKey: 'test-key', url: mock.url, retries: 2, timeoutMs: 3000 });
  return { mock, client };
};

test('client sends the key, model and question format', async () => {
  const { mock, client } = await mk();
  await client.ask({ text: 'x' }, { q: { type: 'noul', instructions: 'Is `text` short?', criteria: { true: 'y', false: 'n' } } });
  assert.equal(mock.seen[0].headers.authorization, 'Bearer test-key');
  assert.equal(mock.seen[0].body.model, 'jev-latest');
  await mock.close();
});

test('client retries on 500 then succeeds, and does not retry on 401', async () => {
  const a = await mk({ failFirst: 2, status: 500 });
  const r = await a.client.ask({ text: 'x' }, { q: { type: 'noul', instructions: 'Is `text` ok?' } });
  assert.ok(r.q);
  assert.equal(a.mock.seen.length, 3);
  await a.mock.close();
  const b = await startMock();
  const bad = createClient({ apiKey: 'wrong', url: b.url, retries: 2 });
  await assert.rejects(bad.ask({}, { q: { type: 'noul', instructions: 'Is `text` ok?' } }), (e) => e.code === 'auth' && e.status === 401);
  assert.equal(b.seen.length, 1);
  await b.close();
});

test('client fails clearly without a key and rejects malformed questions', async () => {
  const c = createClient({ apiKey: null, url: 'http://127.0.0.1:1', retries: 0 });
  const saved = { a: process.env.TYPESAFE_API_KEY, b: process.env.JEV_API_KEY };
  delete process.env.TYPESAFE_API_KEY; delete process.env.JEV_API_KEY;
  const c2 = createClient({ url: 'http://127.0.0.1:1', retries: 0 });
  if (!c2.hasKey) await assert.rejects(c2.ask({}, { q: { type: 'noul', instructions: 'hi' } }), (e) => e.code === 'no_key');
  Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v).map(([k, v]) => [k === 'a' ? 'TYPESAFE_API_KEY' : 'JEV_API_KEY', v])));
  await assert.rejects(c.ask({}, { q: { type: 'bogus', instructions: 'x' } }), (e) => e.code === 'bad_question');
  assert.equal(resolveKey('abc'), 'abc');
});

test('check returns a probability and a boolean', async () => {
  const { mock, client } = await mk();
  const yes = await tools.check(client, { text: 'bad [T]', question: 'Is it bad?' });
  const no = await tools.check(client, { text: 'fine', question: 'Is it bad?' });
  assert.equal(yes.answer, true);
  assert.equal(no.answer, false);
  await mock.close();
});

test('choose and score', async () => {
  const { mock, client } = await mk();
  const c = await tools.choose(client, { text: 'this is a bug report', question: 'Kind?', options: { feature: 'new thing', bug: 'broken thing' } });
  assert.equal(c.choice, 'bug');
  const s = await tools.score(client, { text: 'wow!!', question: 'Excitement?', levels: ['none', 'low', 'mid', 'high'] });
  assert.equal(s.score, 2);
  assert.equal(s.label, 'mid');
  await mock.close();
});

test('route picks a candidate and abstains on none', async () => {
  const { mock, client } = await mk();
  const r = await tools.route(client, { task: 'summarize with the fast model', candidates: [{ id: 'fast', description: 'cheap' }, { id: 'deep', description: 'hard' }] });
  assert.equal(r.choice, 'fast');
  assert.equal(r.abstained, false);
  const n = await tools.route(client, { task: 'nothing here', candidates: ['a', 'b'], minConfidence: 0.95 });
  assert.equal(n.choice, null);
  assert.equal(n.abstained, true);
  await mock.close();
});

test('triage labels many items across batches, in order', async () => {
  const { mock, client } = await mk();
  const items = Array.from({ length: 20 }, (_, i) => (i % 2 ? `invoice number ${i}` : `hello ${i}`));
  const r = await tools.triage(client, { items, labels: { general: 'anything else', invoice: 'billing' } });
  assert.equal(r.results.length, 20);
  r.results.forEach((x, i) => assert.equal(x.label, i % 2 ? 'invoice' : 'general'));
  assert.ok(mock.seen.length >= 3); // 20 items in batches of 8
  await mock.close();
});

test('guard allows, asks and denies', async () => {
  const { mock, client } = await mk();
  assert.equal((await tools.guard(client, { action: 'ls' })).decision, 'allow');
  assert.equal((await tools.guard(client, { action: 'maybe [M]' })).decision, 'ask');
  const d = await tools.guard(client, { action: 'wipe [T]' });
  assert.equal(d.decision, 'deny');
  assert.ok(d.reasons.length > 0);
  await mock.close();
});

test('guard never allows when the model answer is incomplete', async () => {
  const { mock, client } = await mk({ drop: 'destructive' });
  const r = await tools.guard(client, { action: 'anything' });
  assert.equal(r.decision, 'ask');
  assert.match(r.reasons.join(' '), /incomplete/);
  await mock.close();
});

test('describeToolCall covers Bash, Write and other tools', () => {
  assert.match(tools.describeToolCall({ tool_name: 'Bash', tool_input: { command: 'ls' } }), /ls/);
  assert.match(tools.describeToolCall({ tool_name: 'Write', tool_input: { file_path: '/a' } }), /\/a/);
  assert.match(tools.describeToolCall({ tool_name: 'WebFetch', tool_input: { url: 'u' } }), /WebFetch/);
});

test('grep keeps line numbers and supports invert', async () => {
  const { mock, client } = await mk();
  const lines = ['ok', 'error [T]', 'fine', 'error [T] again'];
  const r = await tools.grep(client, { query: 'errors', lines });
  assert.deepEqual(r.matches.map((m) => m.n), [2, 4]);
  const inv = await tools.grep(client, { query: 'errors', lines, invert: true });
  assert.deepEqual(inv.matches.map((m) => m.n), [1, 3]);
  await mock.close();
});

test('rank sorts best first and trims to top', async () => {
  const { mock, client } = await mk();
  const r = await tools.rank(client, { items: ['a', 'b!!', 'c!'], criterion: 'excitement', top: 2 });
  assert.deepEqual(r.ranked.map((x) => x.text), ['b!!', 'c!']);
  await mock.close();
});

test('compact drops irrelevant lines, keeps order and context', async () => {
  const { mock, client } = await mk();
  const lines = ['noise', 'noise', 'key [T]', 'noise', 'noise', 'noise', 'key [T] two'];
  const r = await tools.compact(client, { lines, task: 'find keys', context: 0, always: '' });
  assert.deepEqual(r.kept.map((k) => k.line), ['key [T]', 'key [T] two']);
  assert.deepEqual(r.kept.map((k) => k.n), [3, 7]);
  assert.equal(r.droppedCount, 5);
  const c = await tools.compact(client, { lines, task: 'find keys', context: 1, always: '' });
  assert.equal(c.kept.length, 5);
  await mock.close();
});

test('MCP: initialize, list, call, errors and notifications', async () => {
  const { mock, client } = await mk();
  const init = await handle(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'jev-agent-kit');
  const unknown = await handle(client, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.ok(['2025-06-18', '2025-03-26', '2024-11-05'].includes(unknown.result.protocolVersion));
  assert.equal(await handle(client, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle(client, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(list.result.tools.length, listTools().length);
  for (const t of list.result.tools) { assert.ok(t.name.startsWith('jev_')); assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 20); }
  const call = await handle(client, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'jev_check', arguments: { text: 'x [T]', question: 'q?' } } });
  assert.equal(JSON.parse(call.result.content[0].text).answer, true);
  const bad = await handle(client, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'jev_check', arguments: {} } });
  assert.equal(bad.result.isError, true);
  const none = await handle(client, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(none.error.code, -32602);
  const nm = await handle(client, { jsonrpc: '2.0', id: 7, method: 'nope/method' });
  assert.equal(nm.error.code, -32601);
  await mock.close();
});
