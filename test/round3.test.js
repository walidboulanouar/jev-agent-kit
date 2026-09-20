import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tools from '../src/tools.js';
import { readTextFile } from '../src/files.js';

const safeModel = { ask: async () => ({ destructive: { noul: 0 }, exfiltration: { noul: 0 }, offtask: { noul: 0 }, risk: { score: 0 } }) };
const gate = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'ci-gate.sh');

test('guard scans the raw command, so hook-mode text cannot dodge the deny patterns', async () => {
  const viaHook = tools.describeToolCall({ tool_name: 'Bash', tool_input: { command: 'mkfs.ext4 /dev/sda1' } });
  assert.equal((await tools.guard(safeModel, { action: viaHook })).decision, 'deny');
  assert.equal((await tools.guard(safeModel, { action: 'mkfs.ext4 /dev/sda1' })).decision, 'deny');
  assert.equal((await tools.guard(safeModel, { action: tools.describeToolCall({ tool_name: 'Bash', tool_input: { command: 'echo mkfs' } }) })).decision, 'allow');
});

test('guard denies rm on root and home in the common spellings', async () => {
  for (const a of ['rm -rf /', 'rm -rf /*', 'rm -rf "/"', "rm -rf '/'", 'rm -rf ~', 'rm -rf ~/*', 'rm -fr $HOME', 'rm -rf $HOME/*', 'rm -r -f /', 'rm -rf --no-preserve-root /']) {
    assert.equal((await tools.guard(safeModel, { action: a })).decision, 'deny', a);
  }
  for (const a of ['rm -rf -- /', 'rm --recursive --force /', 'rm -rf ${HOME}', 'rm -rf /*;', 'sudo -n mkfs.ext4 /dev/sda', 'bash -c "mkfs /dev/sda"', '(mkfs /dev/sda)', '$(mkfs /dev/sda)', '/sbin/mkfs.ext4 /dev/sda']) {
    assert.equal((await tools.guard(safeModel, { action: a })).decision, 'deny', a);
  }
  for (const a of ['rm -rf ~/projects/old', 'rm -rf ./build', 'rm -rf /tmp/scratch', 'rm file.txt']) {
    assert.notEqual((await tools.guard(safeModel, { action: a })).decision, 'deny', a);
  }
});

test('grep and compact validate max', async () => {
  for (const max of [null, -1, 0, 'x', 1e9]) {
    await assert.rejects(tools.grep(safeModel, { query: 'x', lines: ['a'], max }), (e) => e.code === 'bad_input', String(max));
    await assert.rejects(tools.compact(safeModel, { lines: ['a'], task: 'x', max }), (e) => e.code === 'bad_input', String(max));
  }
});

test('the always pattern rejects quantified groups and long repeat chains', async () => {
  for (const p of ['(a|a)+$', '(a+|b)+$', '(a|a?)+$', '^(\\w+\\s?)*$', 'a*a*a*a*a*a*a*a*b', '.*.*.*.*.*.*.*x', '(x+)+y']) {
    await assert.rejects(tools.compact(safeModel, { lines: ['a'], task: 'x', always: p }), (e) => e.code === 'bad_input', p);
  }
  await tools.compact({ ask: async () => ({ l0: { noul: 0 } }) }, { lines: ['a'], task: 'x', always: 'boom|crash' });
});

test('path root: the home directory and folders above it are refused', () => {
  const { homedir } = { homedir: () => process.env.HOME };
  for (const root of [homedir(), dirname(homedir()), '/']) {
    assert.throws(() => readTextFile('x.log', { root }), (e) => e.code === 'bad_input', root);
  }
  const dir = mkdtempSync(join(tmpdir(), 'jevr-'));
  writeFileSync(join(dir, '..foo.log'), 'ok');
  // a name that starts with two dots is a dotfile: refused, but not with the escape message
  assert.throws(() => readTextFile('..foo.log', { root: dir }), (e) => /secrets/.test(e.message) && !/inside the working directory/.test(e.message));
});

// ci-gate.sh with a fake jev: exits 0 (secret) when the piece it is given contains the whole token, 1 otherwise.
function runGate({ pad, fake }) {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'jev'), fake, { mode: 0o755 });
  chmodSync(join(bin, 'jev'), 0o755);
  const sh = (c) => spawnSync('bash', ['-c', c], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null' } });
  sh('git init -q && git config user.email a@b.c && git config user.name t');
  writeFileSync(join(dir, 'a.txt'), `${'x'.repeat(pad)}SECRETTOKEN123${'y'.repeat(200)}\n`);
  sh('git add a.txt');
  return spawnSync('bash', [gate], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

const fakeFindsToken = `#!/usr/bin/env bash
file=""; while [ $# -gt 0 ]; do [ "$1" = "--file" ] && file="$2"; shift; done
if grep -q SECRETTOKEN123 "$file"; then exit 0; else exit 1; fi
`;

test('ci-gate blocks a secret that straddles a window boundary (many padding values)', () => {
  // the diff has a fixed header, so try a range of paddings around 5000 to 6000
  for (const pad of [5850, 5880, 5900, 5950, 5980, 6000, 6100, 4900, 4990, 3990, 7900, 10990]) {
    const r = runGate({ pad, fake: fakeFindsToken });
    assert.equal(r.status, 1, `pad ${pad} slipped through: ${r.stderr}`);
  }
});

test('ci-gate blocks on tool errors and passes a clean diff', () => {
  const clean = `#!/usr/bin/env bash\nexit 1\n`;
  assert.equal(runGate({ pad: 10, fake: clean }).status, 0);
  for (const code of [3, 2, 127, 137]) {
    const r = runGate({ pad: 10, fake: `#!/usr/bin/env bash\nexit ${code}\n` });
    assert.equal(r.status, 1, `exit ${code}`);
  }
});
