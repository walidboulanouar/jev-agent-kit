// The tools. Each takes a client and plain input, and returns plain JSON.
// Jev returns probabilities, not text, so every tool ends in a decision your
// code (or your agent) can branch on.
import { noulQ, choiceQ, scoreQ, pmap, chunk, clip, JevError } from './client.js';

const BATCH = 8; // questions over separate items per request; keeps accuracy up
const PARALLEL = 4;

const round = (n, d = 3) => (typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : n);

// ---- 1. core: ask, check, choose, score ----

export async function ask(client, { state, questions }) {
  const answers = await client.ask(state ?? {}, questions);
  return { answers };
}

export async function check(client, { text, question, threshold = 0.5 }) {
  if (!text || !question) throw new JevError('check needs text and question', { code: 'bad_input' });
  const a = await client.ask({ text: clip(text, 8000) }, { q: noulQ(`${question} Judge only \`text\`.`) });
  const p = a.q?.noul;
  return { probability: round(p), answer: p >= threshold, threshold };
}

export async function choose(client, { text, question, options }) {
  if (!text || !options) throw new JevError('choose needs text and options', { code: 'bad_input' });
  const a = await client.ask({ text: clip(text, 8000) }, { q: choiceQ(`${question || 'Which option best fits'} \`text\`?`, options) });
  const r = a.q || {};
  return { choice: r.choice, confidence: round(r.confidence), probabilities: roundMap(r.probabilities) };
}

export async function score(client, { text, question, levels }) {
  if (!text || !question || !levels) throw new JevError('score needs text, question and levels', { code: 'bad_input' });
  const a = await client.ask({ text: clip(text, 8000) }, { q: scoreQ(`${question} Judge only \`text\`.`, levels) });
  const r = a.q || {};
  return { score: round(r.score, 2), max: levels.length - 1, label: levels[Math.round(r.score)] ?? null, confidence: round(r.confidence) };
}

function roundMap(m) {
  if (!m) return m;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
}

// ---- 2. route: pick the best candidate for a task ----

export async function route(client, { task, candidates, k = 3, minConfidence = 0.5 }) {
  if (!task) throw new JevError('route needs a task', { code: 'bad_input' });
  const opts = normalizeCandidates(candidates);
  const criteria = { ...opts, none: 'None of the candidates fits this task' };
  const a = await client.ask({ task: clip(task, 4000) }, { pick: choiceQ('Which candidate best fits the task in `task`?', criteria) });
  const r = a.pick || {};
  const ranking = Object.entries(r.probabilities || {})
    .filter(([id]) => id !== 'none')
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(([id, p]) => ({ id, probability: round(p) }));
  const abstained = r.choice === 'none' || (r.confidence ?? 1) < minConfidence;
  return { choice: abstained ? null : r.choice, abstained, confidence: round(r.confidence), ranking };
}

function normalizeCandidates(c) {
  if (Array.isArray(c)) {
    const out = {};
    for (const x of c) {
      if (typeof x === 'string') out[x] = x;
      else if (x && x.id) out[x.id] = x.description || x.id;
    }
    if (Object.keys(out).length < 1) throw new JevError('route needs at least one candidate', { code: 'bad_input' });
    return out;
  }
  if (c && typeof c === 'object' && Object.keys(c).length) return c;
  throw new JevError('route needs candidates as an array or an object', { code: 'bad_input' });
}

// ---- 3. triage: label many items ----

export async function triage(client, { items, labels, minConfidence = 0.5 }) {
  const norm = normalizeItems(items);
  if (!labels || Object.keys(labels).length < 2) throw new JevError('triage needs at least two labels', { code: 'bad_input' });
  const chunks = chunk(norm, BATCH);
  const res = await pmap(chunks, PARALLEL, async (part) => {
    const state = { items: part.map((x) => clip(x.text)) };
    const qs = {};
    part.forEach((_, i) => { qs[`i${i}`] = choiceQ(`Which label best fits \`items[${i}]\`?`, labels); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => {
      const r = a[`i${i}`] || {};
      const sure = (r.confidence ?? 1) >= minConfidence;
      return { id: x.id, label: sure ? r.choice : null, guess: r.choice, confidence: round(r.confidence), probabilities: roundMap(r.probabilities) };
    });
  });
  return { results: res.flat() };
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) throw new JevError('items must be a non-empty array', { code: 'bad_input' });
  return items.map((x, i) => (typeof x === 'string' ? { id: i, text: x } : { id: x.id ?? i, text: String(x.text ?? '') }));
}

// ---- 4. guard: judge an agent action before it runs ----

export const DEFAULT_POLICY = {
  deny: 0.85,   // any danger probability at or above this blocks
  ask: 0.4,     // at or above this asks a human
  riskAsk: 2.5, // risk score (0..4) at or above this asks a human
};

export async function guard(client, { action, context = '', policy = {} }) {
  if (!action) throw new JevError('guard needs an action', { code: 'bad_input' });
  const pol = { ...DEFAULT_POLICY, ...policy };
  const state = { action: clip(action, 4000), context: clip(context, 2000) };
  const a = await client.ask(state, {
    destructive: noulQ('Would running `action` delete, overwrite or destroy data or config that is hard to recover?'),
    exfiltration: noulQ('Would running `action` send secrets, credentials or private data to an outside party?'),
    offtask: noulQ('Is `action` unrelated to or beyond what `context` says the user asked for? If `context` is empty, answer false.'),
    risk: scoreQ('How risky is running `action` for the user, considering harm and reversibility?', ['harmless', 'low', 'medium', 'high', 'severe']),
  });
  const complete = ['destructive', 'exfiltration', 'offtask'].every((k) => typeof a[k]?.noul === 'number') && typeof a.risk?.score === 'number';
  const p = { destructive: a.destructive?.noul ?? 0, exfiltration: a.exfiltration?.noul ?? 0, offtask: a.offtask?.noul ?? 0 };
  const risk = a.risk?.score ?? 0;
  const reasons = [];
  let decision = 'allow';
  // A guard that cannot read the model's answer must not wave the action through.
  if (!complete) { decision = 'ask'; reasons.push('incomplete model answer'); }
  for (const [k, v] of Object.entries(p)) {
    if (v >= pol.deny && k !== 'offtask') { decision = 'deny'; reasons.push(`${k} ${round(v, 2)}`); }
  }
  if (decision !== 'deny') {
    for (const [k, v] of Object.entries(p)) if (v >= pol.ask) { decision = 'ask'; reasons.push(`${k} ${round(v, 2)}`); }
    if (risk >= pol.riskAsk) { decision = 'ask'; reasons.push(`risk ${round(risk, 1)} of 4`); }
  }
  return { decision, reasons, probabilities: roundMap(p), risk: round(risk, 2), policy: pol };
}

// Turn a Claude Code PreToolUse hook payload into an action string.
export function describeToolCall(payload) {
  const name = payload?.tool_name || 'unknown tool';
  const input = payload?.tool_input || {};
  if (name === 'Bash' && input.command) return `Run shell command: ${input.command}`;
  if ((name === 'Write' || name === 'Edit') && input.file_path) return `${name} file ${input.file_path}`;
  return `${name} with input ${JSON.stringify(input).slice(0, 1500)}`;
}

// ---- 5. grep: filter lines by meaning ----

export async function grep(client, { query, lines, threshold = 0.7, invert = false, max = 5000 }) {
  if (!query) throw new JevError('grep needs a query', { code: 'bad_input' });
  if (!Array.isArray(lines)) throw new JevError('grep needs lines as an array', { code: 'bad_input' });
  const capped = lines.slice(0, max);
  const parts = chunk(capped.map((text, n) => ({ n: n + 1, text })), 25);
  const res = await pmap(parts, PARALLEL, async (part) => {
    const state = { lines: part.map((x) => clip(x.text, 600)) };
    const qs = {};
    part.forEach((_, i) => { qs[`l${i}`] = noulQ(`Does \`lines[${i}]\` match this description: ${query}`); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => ({ n: x.n, line: x.text, probability: round(a[`l${i}`]?.noul ?? 0) }));
  });
  const all = res.flat();
  const matches = all.filter((r) => (invert ? r.probability < threshold : r.probability >= threshold));
  return { matches, scanned: all.length, truncated: lines.length > capped.length };
}

// ---- 6. rank: order items by a criterion ----

const DEFAULT_LEVELS = ['very low', 'low', 'medium', 'high', 'very high'];

export async function rank(client, { items, criterion, levels = DEFAULT_LEVELS, top = null }) {
  if (!criterion) throw new JevError('rank needs a criterion', { code: 'bad_input' });
  const norm = normalizeItems(items);
  const parts = chunk(norm, BATCH);
  const res = await pmap(parts, PARALLEL, async (part) => {
    const state = { items: part.map((x) => clip(x.text)) };
    const qs = {};
    part.forEach((_, i) => { qs[`s${i}`] = scoreQ(`Rate \`items[${i}]\` on: ${criterion}`, levels); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => ({ id: x.id, text: x.text, score: round(a[`s${i}`]?.score ?? 0, 2), confidence: round(a[`s${i}`]?.confidence) }));
  });
  const sorted = res.flat().sort((x, y) => y.score - x.score);
  return { max: levels.length - 1, ranked: top ? sorted.slice(0, top) : sorted };
}

// ---- 7. compact: drop lines that no longer matter for a task ----

export async function compact(client, { lines, task, threshold = 0.5, context = 0, max = 5000 }) {
  if (!task) throw new JevError('compact needs a task', { code: 'bad_input' });
  if (!Array.isArray(lines)) throw new JevError('compact needs lines as an array', { code: 'bad_input' });
  const capped = lines.slice(0, max);
  const parts = chunk(capped.map((text, n) => ({ n, text })), 25);
  const res = await pmap(parts, PARALLEL, async (part) => {
    const state = { task: clip(task, 1000), lines: part.map((x) => clip(x.text, 600)) };
    const qs = {};
    part.forEach((_, i) => { qs[`l${i}`] = noulQ(`Is \`lines[${i}]\` still useful for the work described in \`task\`?`); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => ({ n: x.n, p: a[`l${i}`]?.noul ?? 1 }));
  });
  const flat = res.flat();
  const keep = new Set();
  flat.forEach((r) => {
    if (r.p >= threshold) for (let d = -context; d <= context; d++) keep.add(r.n + d);
  });
  const kept = capped.filter((_, n) => keep.has(n));
  // lines beyond the cap are kept untouched so nothing is lost silently
  const tail = lines.slice(capped.length);
  return {
    kept: [...kept, ...tail],
    keptCount: kept.length + tail.length,
    droppedCount: capped.length - kept.length,
    total: lines.length,
    savedFraction: round(lines.length ? (capped.length - kept.length) / lines.length : 0, 2),
  };
}
