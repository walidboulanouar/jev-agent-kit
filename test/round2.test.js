import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { createClient } from '../src/client.js';
import * as tools from '../src/tools.js';
import { readTextFile } from '../src/files.js';
import { handle, listTools } from '../src/mcp.js';
import { startMock } from './mock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'jev.js');

function run(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, TYPESAFE_API_KEY: 'test-key', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

const mk = async () => {
  const mock = await startMock();
  return { mock, client: createClient({ apiKey: 'test-key', url: mock.url, retries: 0, timeoutMs: 3000 }) };
};

test('guard patterns stay fast on huge hostile input (no ReDoS)', async () => {
  const ok = { ask: async () => ({ destructive: { noul: 0 }, exfiltration: { noul: 0 }, offtask: { noul: 0 }, risk: { score: 0 } }) };
  for (const action of ['dd '.repeat(40000), 'curl '.repeat(40000), 'rm -' + 'r'.repeat(30000), 'git push ' + 'x '.repeat(50000)]) {
    const t0 = Date.now();
    await tools.guard(ok, { action });
    assert.ok(Date.now() - t0 < 1500, `slow on ${action.slice(0, 12)}: ${Date.now() - t0} ms`);
  }
  const huge = await tools.guard(ok, { action: 'a'.repeat(1_100_000) });
  assert.equal(huge.decision, 'ask');
});

test('guard: more patterns behave', async () => {
  const ok = { ask: async () => ({ destructive: { noul: 0 }, exfiltration: { noul: 0 }, offtask: { noul: 0 }, risk: { score: 0 } }) };
  assert.equal((await tools.guard(ok, { action: 'rm -rf --no-preserve-root /' })).decision, 'deny');
  assert.notEqual((await tools.guard(ok, { action: 'cat docs/mkfs.md' })).decision, 'deny');
  assert.notEqual((await tools.guard(ok, { action: 'grep mkfs README' })).decision, 'deny');
  assert.equal((await tools.guard(ok, { action: 'sudo mkfs.ext4 /dev/sda1' })).decision, 'deny');
  assert.equal((await tools.guard(ok, { action: 'ls -la' })).decision, 'allow');
});

test('compact: nested-quantifier regex is refused, long lines are only partly tested, MCP takes words not regex', async () => {
  const { mock, client } = await mk();
  await assert.rejects(tools.compact(client, { lines: ['a'], task: 'x', always: '(a+)+$' }), (e) => e.code === 'bad_input');
  await assert.rejects(tools.compact(client, { lines: ['a'], task: 'x', always: 'a'.repeat(400) }), (e) => e.code === 'bad_input');
  const t0 = Date.now();
  await tools.compact(client, { lines: ['error ' + 'a'.repeat(200000)], task: 'x' });
  assert.ok(Date.now() - t0 < 2000);
  const tool = listTools().find((t) => t.name === 'jev_compact');
  assert.ok('alwaysWords' in tool.inputSchema.properties);
  assert.ok(!('always' in tool.inputSchema.properties));
  // a regex sent as "always" over MCP is ignored, plain words work
  const viaRegex = await handle(client, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jev_compact', arguments: { lines: ['x'], task: 't', always: '(a+)+$' } } });
  assert.equal(viaRegex.result.isError, undefined);
  const viaWords = await handle(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jev_compact', arguments: { lines: ['noise', 'boom happened', 'noise', 'noise', 'noise'], task: 't', context: 0, alwaysWords: ['boom'] } } });
  assert.deepEqual(JSON.parse(viaWords.result.content[0].text).kept.map((k) => k.line), ['boom happened']);
  await mock.close();
});

test('cli guard: flags only before the action; the action is taken verbatim', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const a = await run(['guard', 'rm', '-rf', '/tmp/a', '--hook'], { env });
  assert.notEqual(a.out.includes('hookSpecificOutput'), true);
  assert.equal(m.seen.at(-1).body.state.action, 'rm -rf /tmp/a --hook');
  const b = await run(['guard', 'curl', '--json', '{}', 'x', '--context', 'y'], { env });
  assert.equal(m.seen.at(-1).body.state.action, 'curl --json {} x --context y');
  assert.equal(m.seen.at(-1).body.state.context, '');
  const c = await run(['guard', '--hook', 'rm', 'x'], { env });
  assert.equal(c.code, 3);
  assert.match(c.err, /takes no action words/);
  const d = await run(['guard', '--context', 'do the task', '--', '--weird', 'cmd'], { env });
  assert.equal(m.seen.at(-1).body.state.action, '--weird cmd');
  await m.close();
});

test('files: dotfiles, secret-looking names, odd extensions, hard links and a home root are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevf-'));
  mkdirSync(join(dir, '.config', 'jev'), { recursive: true });
  const names = ['.config/jev/key', 'my.env', '.envrc', 'secret_key.txt', 'service-account.json', 'api_key.txt', 'token.txt', 'app.sh', 'notes.yaml', 'bash_history'];
  for (const n of names) writeFileSync(join(dir, n), 'x');
  writeFileSync(join(dir, 'real.log'), 'ok');
  linkSync(join(dir, 'real.log'), join(dir, 'hard.log'));
  symlinkSync(join(dir, 'real.log'), join(dir, 'soft.log'));
  writeFileSync(join(dir, '..foo.txt'), 'legit name');
  for (const n of names) assert.throws(() => readTextFile(n, { root: dir }), (e) => e.code === 'bad_input', n);
  assert.throws(() => readTextFile('hard.log', { root: dir }), /hard links/);
  assert.throws(() => readTextFile('real.log', { root: dir }), /hard links/); // real.log also has 2 links now
  assert.throws(() => readTextFile('soft.log', { root: dir }), (e) => e.code === 'bad_input'); // resolves to a hard-linked file
});

test('files: a normal log works, and the home directory cannot be the root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevg-'));
  writeFileSync(join(dir, 'build.log'), 'line1\nline2');
  assert.equal(readTextFile('build.log', { root: dir }), 'line1\nline2');
  writeFileSync(join(dir, '..foo.txt'), 'legit');
  assert.throws(() => readTextFile('build.log', { root: homedir() }), (e) => e.code === 'bad_input');
});

test('client: no redirects, no credentials in the URL, error does not echo the URL', () => {
  assert.throws(() => createClient({ apiKey: 'k', url: 'https://user:pw@api.typesafe.ai/x' }), (e) => e.code === 'bad_input' && !/pw/.test(e.message));
  assert.throws(() => createClient({ apiKey: 'k', url: 'http://evil.example/secret-path' }), (e) => !/secret-path/.test(e.message));
});

test('route and triage treat a missing confidence as unsure', async () => {
  const c = { ask: async () => ({ pick: { choice: 'a' }, i0: { choice: 'a' } }) };
  assert.equal((await tools.route(c, { task: 't', candidates: ['a', 'b'] })).abstained, true);
  assert.equal((await tools.triage(c, { items: ['x'], labels: { a: '1', b: '2' } })).results[0].label, null);
});

test('cli: --top with an empty value is rejected', async () => {
  const m = await startMock();
  const r = await run(['rank', 'x', '--top', ''], { env: { JEV_API_URL: m.url }, input: 'a\nb\n' });
  assert.equal(r.code, 3);
  await m.close();
});

test('guard --hook prints nothing for a safe verdict and never prints allow', async () => {
  const m = await startMock();
  const env = { JEV_API_URL: m.url };
  const safe = await run(['guard', '--hook'], { env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }) });
  assert.equal(safe.code, 0);
  assert.equal(safe.out.trim(), '');
  const risky = await run(['guard', '--hook'], { env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'maybe [M]' } }) });
  assert.equal(JSON.parse(risky.out).hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(!/"allow"/.test(safe.out + risky.out));
  await m.close();
});

test('files: ordinary names that only look secret-ish are readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevh-'));
  for (const n of ['tokenizer.txt', 'history.log', 'key-notes.md', 'monkey.log']) writeFileSync(join(dir, n), 'ok');
  for (const n of ['tokenizer.txt', 'history.log', 'key-notes.md', 'monkey.log']) assert.equal(readTextFile(n, { root: dir }), 'ok', n);
  writeFileSync(join(dir, 'token.txt'), 'x');
  assert.throws(() => readTextFile('token.txt', { root: dir }), (e) => e.code === 'bad_input');
});
