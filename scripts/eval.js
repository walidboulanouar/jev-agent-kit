#!/usr/bin/env node
// Measure guard, compact and grep against the real model on the labeled fixtures.
// Costs a few cents. Needs a key. Prints a summary and writes it to docs/measured.json.
//   TYPESAFE_API_KEY=... node scripts/eval.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient, pmap } from '../src/client.js';
import * as tools from '../src/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', f), 'utf8'));
const client = createClient();
if (!client.hasKey) { console.error('No API key. Set TYPESAFE_API_KEY.'); process.exit(3); }

const out = { date: new Date().toISOString().slice(0, 10), model: client.model };

// guard: risky commands should be ask or deny; safe ones should be allow
{
  const { items } = load('guard.json');
  const res = await pmap(items, 4, async (it) => ({ ...it, ...(await tools.guard(client, { action: it.action, context: '' })) }));
  const risky = res.filter((r) => r.label === 'risky');
  const safe = res.filter((r) => r.label === 'safe');
  const missed = risky.filter((r) => r.decision === 'allow');
  const noisy = safe.filter((r) => r.decision !== 'allow');
  out.guard = {
    risky: risky.length, safe: safe.length,
    riskyCaught: risky.length - missed.length, riskyAllowed: missed.length,
    safeAllowed: safe.length - noisy.length, safeFlagged: noisy.length,
    byPatternOnly: res.filter((r) => r.source === 'pattern').length,
    missedActions: missed.map((r) => r.action),
    flaggedSafeActions: noisy.map((r) => `${r.action} -> ${r.decision}`),
  };
}

// compact and grep on a build log
{
  const f = load('build-log.json');
  const lines = f.lines.map((l) => l.line);
  const relevant = new Set(f.lines.map((l, i) => (l.relevant ? i + 1 : 0)).filter(Boolean));
  const score = (keptN) => {
    const kept = new Set(keptN);
    const rec = [...relevant].filter((n) => kept.has(n)).length;
    return { keptLines: kept.size, of: lines.length, relevantKept: rec, relevantTotal: relevant.size, recall: +(rec / relevant.size).toFixed(2), precision: +(rec / Math.max(kept.size, 1)).toFixed(2) };
  };
  const modelOnly = await tools.compact(client, { lines, task: f.task, context: 0, always: '' });
  const defaults = await tools.compact(client, { lines, task: f.task });
  const pinnedNoContext = await tools.compact(client, { lines, task: f.task, context: 0 });
  const g = await tools.grep(client, { query: `lines that help someone ${f.task}`, lines, threshold: 0.5 });
  out.compact = {
    modelOnlyNoContext: score(modelOnly.kept.map((k) => k.n)),
    withDefaults: score(defaults.kept.map((k) => k.n)),
    pinnedErrorsNoContext: score(pinnedNoContext.kept.map((k) => k.n)),
    grep: score(g.matches.map((m) => m.n)),
    missedByModelOnly: [...relevant].filter((n) => !modelOnly.kept.some((k) => k.n === n)).map((n) => lines[n - 1]),
  };
}

writeFileSync(join(here, '..', 'docs', 'measured.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
