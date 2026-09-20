import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startMock } from './mock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'jev.js');
const mcpBin = join(root, 'bin', 'jev-mcp.js');

function run(args, { input = '', env = {}, file = bin } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...args], { env: { ...process.env, TYPESAFE_API_KEY: 'test-key', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

test('cli check uses exit codes', async () => {
  const m = await startMock();
  const yes = await run(['check', 'Is it bad?'], { input: 'bad [T]', env: { JEV_API_URL: m.url } });
  const no = await run(['check', 'Is it bad?'], { input: 'fine', env: { JEV_API_URL: m.url } });
  assert.equal(yes.code, 0);
  assert.equal(no.code, 1);
  assert.match(yes.out, /^yes/);
  await m.close();
});

test('cli guard exit codes: allow 0, ask 2, deny 1', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  assert.equal((await run(['guard', 'ls'], { env })).code, 0);
  assert.equal((await run(['guard', 'maybe [M]'], { env })).code, 2);
  assert.equal((await run(['guard', 'wipe [T]'], { env })).code, 1);
  await m.close();
});

test('cli guard --hook prints a PreToolUse decision and asks on bad input', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const ok = await run(['guard', '--hook'], { env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'wipe [T]' } }) });
  const parsed = JSON.parse(ok.out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  const junk = await run(['guard', '--hook'], { env, input: 'not json' });
  assert.equal(JSON.parse(junk.out).hookSpecificOutput.permissionDecision, 'ask');
  const down = await run(['guard', '--hook'], { env: { JEV_API_URL: 'http://127.0.0.1:1' }, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(JSON.parse(down.out).hookSpecificOutput.permissionDecision, 'ask');
  await m.close();
});

test('cli grep, triage, compact, rank read stdin lines', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const g = await run(['grep', 'errors'], { env, input: 'ok\nerror [T]\nfine\n' });
  assert.equal(g.out.trim(), '2: error [T]');
  const t = await run(['triage', '-o', 'other=rest', '-o', 'invoice=billing'], { env, input: 'invoice 1\nhello\n' });
  assert.deepEqual(t.out.trim().split('\n').map((l) => l.split('\t')[0]), ['invoice', 'other']);
  const c = await run(['compact', 'find keys', '--around', '0'], { env, input: 'noise\nkey [T]\nnoise\n' });
  assert.equal(c.out.trim(), 'key [T]');
  assert.match(c.err, /kept 1 of 3/);
  const r = await run(['rank', 'excitement', '--top', '1'], { env, input: 'a\nb!!\nc!\n' });
  assert.match(r.out, /b!!/);
  await m.close();
});

test('cli reports errors with exit code 3 and never prints the key', async () => {
  const m = await startMock();
  const bad = await run(['check', 'q'], { input: 'x', env: { JEV_API_URL: m.url, TYPESAFE_API_KEY: 'super-secret-key' } });
  assert.equal(bad.code, 3);
  assert.ok(!bad.out.includes('super-secret-key') && !bad.err.includes('super-secret-key'));
  const usage = await run(['choose', 'q', '-o', 'nope'], { input: 'x', env: { JEV_API_URL: m.url } });
  assert.equal(usage.code, 3);
  assert.match(usage.err, /name=meaning/);
  const unknown = await run(['wat']);
  assert.equal(unknown.code, 3);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: jev/);
  await m.close();
});

test('MCP over real stdio: initialize, list, call, and a parse error', async () => {
  const m = await startMock();
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jev_check', arguments: { text: 'x [T]', question: 'q?' } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n';
  const r = await run([], { file: mcpBin, input: msgs, env: { JEV_API_URL: m.url } });
  const replies = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies.length, 4); // 3 requests + 1 parse error, no reply to the notification
  assert.equal(replies.find((x) => x.id === 1).result.protocolVersion, '2025-06-18');
  assert.ok(replies.find((x) => x.id === 2).result.tools.length >= 10);
  assert.equal(JSON.parse(replies.find((x) => x.id === 3).result.content[0].text).answer, true);
  assert.equal(replies.find((x) => x.error?.code === -32700).id, null);
  await m.close();
});

test('cli: strict flags, numeric checks, friendly errors', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const unk = await run(['check', 'q', '--bogus'], { env, input: 'x' });
  assert.equal(unk.code, 3);
  assert.match(unk.err, /Unknown option --bogus/);
  const badT = await run(['grep', 'x', '-t', 'abc'], { env, input: 'a\n' });
  assert.equal(badT.code, 3);
  assert.match(badT.err, /-t must be a number/);
  const badTop = await run(['rank', 'x', '--top', '-1'], { env, input: 'a\n' });
  assert.equal(badTop.code, 3);
  const nofile = await run(['check', 'q', '--file', '/nope/missing.txt'], { env });
  assert.equal(nofile.code, 3);
  assert.match(nofile.err, /cannot read file/);
  const empty = await run(['compact', 'task'], { env, input: '' });
  assert.equal(empty.code, 3);
  assert.match(empty.err, /empty/i);
  const noCmd = await run([], { env });
  assert.equal(noCmd.code, 3);
  const routeNone = await run(['route', 'task'], { env });
  assert.equal(routeNone.code, 3);
  assert.match(routeNone.err, /-c id=description/);
  await m.close();
});

test('cli guard: flag-like words stay part of the action', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const r = await run(['guard', 'cat', '-f', '/etc/shadow', '[T]', '--json'], { env });
  assert.equal(r.code, 1); // [T] in the action makes the mock say destructive
  assert.equal(m.seen.at(-1).body.state.action, 'cat -f /etc/shadow [T]');
  const ctx = await run(['guard', 'ls', '--context', 'list files'], { env });
  assert.equal(ctx.code, 0);
  assert.equal(m.seen.at(-1).body.state.context, 'list files');
  await m.close();
});

test('cli judge exit codes and grep | compact chaining with --raw', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const pass = await run(['judge', '-q', 'a?', '-q', 'b?'], { env, input: 'yes [T]' });
  const fail = await run(['judge', '-q', 'a?'], { env, input: 'plain' });
  assert.equal(pass.code, 0);
  assert.equal(fail.code, 1);
  const g = await run(['grep', 'x', '--raw'], { env, input: 'a\nk [T]\nb\n' });
  assert.equal(g.out, 'k [T]\n');
  const c = await run(['compact', 'x', '--around', '0', '--always', ''], { env, input: g.out });
  assert.equal(c.out.trim(), 'k [T]');
  const j = await run(['grep', 'x', '--jsonl'], { env, input: 'a\nk [T]\n' });
  assert.deepEqual(JSON.parse(j.out.trim()).n, 2);
  await m.close();
});

test('cli compact never drops error lines by default', async () => {
  const m = await startMock();
  const r = await run(['compact', 'x', '--around', '0'], { env: { JEV_API_URL: m.url }, input: 'noise\nfatal: boom\nnoise\nnoise\nnoise\n' });
  assert.equal(r.out.trim(), 'fatal: boom');
  assert.match(r.err, /pinned/);
  await m.close();
});
