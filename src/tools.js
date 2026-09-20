// The tools. Each takes a client and plain input, and returns plain JSON.
// Jev returns probabilities, not text, so every tool ends in a decision your
// code (or your agent) can branch on. Line numbers are 1-based everywhere.
import { noulQ, choiceQ, scoreQ, pmap, chunk, clip, JevError } from './client.js';
import { readTextFile, splitLines } from './files.js';

const ITEM_BATCH = 8;   // items per request for triage and rank
const LINE_BATCH = 12;  // lines per request for grep and compact (less unrelated text per request)
const PARALLEL = 4;
const MAX_LINES = 5000;

const round = (n, d = 3) => (typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : n);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const blank = (s) => !String(s ?? '').trim();

function roundMap(m) {
  if (!m) return m;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
}

function needStr(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new JevError(`${name} must be a non-empty string`, { code: 'bad_input' });
  return v;
}
function needNum(v, name, min, max) {
  if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
    throw new JevError(`${name} must be a number from ${min} to ${max}`, { code: 'bad_input' });
  }
  return v;
}

// Accept lines inline or from a file path (MCP: the server reads the file, so
// the agent does not have to paste a large log into its own output).
function linesFrom({ lines, path }, what = 'lines') {
  if (path !== undefined && lines !== undefined) throw new JevError(`give either ${what} or path, not both`, { code: 'bad_input' });
  if (path !== undefined) return splitLines(readTextFile(path));
  if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) {
    throw new JevError(`${what} must be an array of strings, or pass a path`, { code: 'bad_input' });
  }
  return lines;
}

// ---- 1. core: ask, check, choose, score, judge ----

export async function ask(client, { state, questions }) {
  const answers = await client.ask(state ?? {}, questions);
  return { answers };
}

export async function check(client, { text, question, threshold = 0.5 }) {
  needStr(text, 'text'); needStr(question, 'question'); needNum(threshold, 'threshold', 0, 1);
  const a = await client.ask({ text: clip(text, 8000) }, { q: noulQ(`${question} Judge only \`text\`.`) });
  const p = a.q?.noul;
  if (!isNum(p)) throw new JevError('the model returned no answer', { code: 'api' });
  return { probability: round(p), answer: p >= threshold, threshold };
}

export async function choose(client, { text, question, options, minConfidence = 0 }) {
  needStr(text, 'text');
  if (!options || typeof options !== 'object' || Object.keys(options).length < 2) throw new JevError('options must be an object with at least two entries', { code: 'bad_input' });
  const a = await client.ask({ text: clip(text, 8000) }, { q: choiceQ(`${question || 'Which option best fits'} \`text\`?`, options) });
  const r = a.q || {};
  const unsure = typeof r.confidence === 'number' && r.confidence < minConfidence;
  return { choice: unsure ? null : r.choice ?? null, guess: r.choice ?? null, confidence: round(r.confidence), probabilities: roundMap(r.probabilities) };
}

export async function score(client, { text, question, levels }) {
  needStr(text, 'text'); needStr(question, 'question');
  if (!Array.isArray(levels) || levels.length < 2) throw new JevError('levels must be an ordered array of at least two strings', { code: 'bad_input' });
  const a = await client.ask({ text: clip(text, 8000) }, { q: scoreQ(`${question} Judge only \`text\`.`, levels) });
  const r = a.q || {};
  return { score: round(r.score, 1), max: levels.length - 1, label: levels[Math.round(r.score)] ?? null, confidence: round(r.confidence) };
}

// Several yes/no checks over one text in a single request. pass = every check passes.
export async function judge(client, { text, questions, threshold = 0.5 }) {
  needStr(text, 'text'); needNum(threshold, 'threshold', 0, 1);
  if (!Array.isArray(questions) || !questions.length || questions.some((q) => typeof q !== 'string' || !q.trim())) {
    throw new JevError('questions must be a non-empty array of strings', { code: 'bad_input' });
  }
  if (questions.length > 20) throw new JevError('at most 20 questions per judge call', { code: 'bad_input' });
  const qs = {};
  questions.forEach((q, i) => { qs[`q${i}`] = noulQ(`${q} Judge only \`text\`.`); });
  const a = await client.ask({ text: clip(text, 8000) }, qs);
  const results = questions.map((q, i) => {
    const p = a[`q${i}`]?.noul;
    return { question: q, probability: round(p), pass: typeof p === 'number' && p >= threshold };
  });
  const missing = results.some((r) => typeof r.probability !== 'number');
  return { pass: !missing && results.every((r) => r.pass), incomplete: missing, threshold, results };
}

// ---- 2. route: pick the best candidate for a task ----

export async function route(client, { task, candidates, k = 3, minConfidence = 0.5 }) {
  needStr(task, 'task'); needNum(minConfidence, 'minConfidence', 0, 1);
  const opts = normalizeCandidates(candidates);
  if ('none' in opts) throw new JevError('"none" is reserved. Rename that candidate.', { code: 'bad_input' });
  const criteria = { ...opts, none: 'None of the candidates fits this task' };
  const a = await client.ask({ task: clip(task, 4000) }, { pick: choiceQ('Which candidate best fits the task in `task`?', criteria) });
  const r = a.pick || {};
  const ranking = Object.entries(r.probabilities || {})
    .filter(([id]) => id !== 'none')
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(([id, p]) => ({ id, probability: round(p) }));
  const abstained = r.choice === 'none' || typeof r.choice !== 'string' || !isNum(r.confidence) || r.confidence < minConfidence;
  return { choice: abstained ? null : r.choice, abstained, confidence: round(r.confidence), ranking };
}

function normalizeCandidates(c) {
  if (Array.isArray(c)) {
    const out = {};
    for (const x of c) {
      if (typeof x === 'string') out[x] = x;
      else if (x && typeof x.id === 'string') out[x.id] = x.description || x.id;
    }
    if (Object.keys(out).length < 1) throw new JevError('route needs at least one candidate', { code: 'bad_input' });
    return out;
  }
  if (c && typeof c === 'object' && Object.keys(c).length) return { ...c };
  throw new JevError('route needs at least one candidate', { code: 'bad_input' });
}

// ---- 3. triage: label many items ----

// Items: strings or {id, text}. From a path, each non-blank line is an item whose id is its 1-based line number.
function itemsFrom({ items, path }) {
  if (path !== undefined) {
    if (items !== undefined) throw new JevError('give either items or path, not both', { code: 'bad_input' });
    return splitLines(readTextFile(path)).map((text, i) => ({ id: i + 1, text })).filter((x) => !blank(x.text));
  }
  if (!Array.isArray(items) || !items.length) throw new JevError('items must be a non-empty array, or pass a path', { code: 'bad_input' });
  return items.map((x, i) => (typeof x === 'string' ? { id: i + 1, text: x } : { id: x?.id ?? i + 1, text: String(x?.text ?? '') })).filter((x) => !blank(x.text));
}

export async function triage(client, { items, path, labels, minConfidence = 0.5 }) {
  const norm = itemsFrom({ items, path });
  if (!norm.length) throw new JevError('no non-empty items to label', { code: 'bad_input' });
  if (!labels || typeof labels !== 'object' || Object.keys(labels).length < 2) throw new JevError('labels must be an object with at least two entries', { code: 'bad_input' });
  needNum(minConfidence, 'minConfidence', 0, 1);
  const res = await pmap(chunk(norm, ITEM_BATCH), PARALLEL, async (part) => {
    const state = { items: part.map((x) => clip(x.text)) };
    const qs = {};
    part.forEach((_, i) => { qs[`i${i}`] = choiceQ(`Which label best fits \`items[${i}]\`?`, labels); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => {
      const r = a[`i${i}`] || {};
      const sure = typeof r.choice === 'string' && isNum(r.confidence) && r.confidence >= minConfidence;
      return { id: x.id, n: x.id, text: x.text, label: sure ? r.choice : null, guess: r.choice ?? null, confidence: round(r.confidence), probabilities: roundMap(r.probabilities) };
    });
  });
  return { results: res.flat() };
}

// ---- 4. guard: judge an action before an agent runs it ----

export const DEFAULT_POLICY = {
  deny: 0.85,   // destructive or exfiltration probability at or above this blocks
  ask: 0.4,     // any probability at or above this asks a human
  riskAsk: 2.5, // risk score (0..4) at or above this asks a human
};

// Fast path for a few catastrophic patterns. It can only tighten a decision
// (deny or ask). It never allows anything, so it adds no false comfort.
// Every pattern uses bounded quantifiers and runs on a bounded window, so a
// hostile 1 MB action cannot make it slow (ReDoS).
const HARD_DENY = [
  [/\brm\s{1,5}(-[a-zA-Z]{1,10}\s{1,5}){1,4}(\/|~|\$HOME)(\s|\/?$|\/\*)/, 'recursive delete of root or home'],
  [/\brm\b[^\n]{0,80}--no-preserve-root/, 'recursive delete with the root safeguard off'],
  [/(^|[;&|]\s{0,5}|\bsudo\s{1,5})mkfs(\.\w{1,10})?\b/, 'formats a disk'],
  [/\bdd\b[^\n]{0,200}\bof=\/dev\/(sd|nvme|disk|hd)/, 'writes raw to a disk device'],
  [/:\(\)\s{0,3}\{\s{0,3}:\|:&\s{0,3}\};:/, 'fork bomb'],
];
const FORCE_ASK = [
  [/\b(curl|wget)\b[^\n|]{0,300}\|\s{0,5}(sudo\s{1,5})?(ba|z)?sh\b/, 'pipes a download into a shell'],
  [/\bgit\s{1,5}push\b[^\n]{0,300}(--force\b|--force-with-lease\b|\s-f\b)/, 'force push'],
  [/\bchmod\s+-R\s+0?777\b/, 'recursive world-writable permissions'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'drops a database object'],
  [/(\/etc\/(shadow|sudoers)|(^|[\s\/~])\.ssh\/|\.aws\/credentials|\bid_(rsa|ed25519|ecdsa)\b|(^|[\s\/])\.env(\.\w+)?(\s|$))/i, 'touches a file that usually holds secrets'],
];

const ACTION_MAX = 4000;
const ACTION_HARD_MAX = 1_000_000;
const SCAN_WINDOW = 20000;

// Thresholds are clamped so a bad or hostile value cannot turn the guard off.
function safePolicy(policy) {
  const pol = { ...DEFAULT_POLICY };
  for (const k of Object.keys(DEFAULT_POLICY)) {
    const v = policy?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new JevError(`policy.${k} must be a number`, { code: 'bad_input' });
    pol[k] = k === 'riskAsk' ? Math.min(Math.max(v, 0), DEFAULT_POLICY.riskAsk + 1) : Math.min(Math.max(v, 0), DEFAULT_POLICY[k] + 0.1);
  }
  return pol;
}

export async function guard(client, { action, context = '', policy = {} }) {
  needStr(action, 'action');
  const pol = safePolicy(policy);
  const reasons = [];
  let floor = 'allow';
  if (action.length > ACTION_HARD_MAX) {
    return { decision: 'ask', reasons: ['action is larger than 1 MB and was not judged'], probabilities: null, risk: null, policy: pol, source: 'pattern', action: clip(action, 300) };
  }
  const scan = action.length > SCAN_WINDOW ? `${action.slice(0, SCAN_WINDOW / 2)}\n${action.slice(-SCAN_WINDOW / 2)}` : action;
  // A long action is judged on its head and tail, and never allowed outright.
  let judged = action;
  if (action.length > ACTION_MAX) {
    const half = ACTION_MAX / 2;
    judged = `${action.slice(0, half)}\n[... ${action.length - ACTION_MAX} characters not shown ...]\n${action.slice(-half)}`;
    floor = 'ask';
    reasons.push('action is longer than 4000 characters and was only partly judged');
  }
  for (const [re, why] of HARD_DENY) {
    if (re.test(scan)) return { decision: 'deny', reasons: [`pattern: ${why}`], probabilities: null, risk: null, policy: pol, source: 'pattern', action: clip(action, 300) };
  }
  for (const [re, why] of FORCE_ASK) if (re.test(scan)) { floor = 'ask'; reasons.push(`pattern: ${why}`); }

  const state = { action: judged, context: clip(context, 2000) };
  const a = await client.ask(state, {
    destructive: noulQ('Would running `action` delete, overwrite or destroy data or config that is hard to recover?'),
    exfiltration: noulQ('Would running `action` send secrets, credentials or private data to an outside party?'),
    offtask: noulQ('Is `action` unrelated to or beyond what `context` says the user asked for? If `context` is empty, answer false.'),
    risk: scoreQ('How risky is running `action` for the user, considering harm and reversibility?', ['harmless', 'low', 'medium', 'high', 'severe']),
  });
  const complete = ['destructive', 'exfiltration', 'offtask'].every((k) => isNum(a[k]?.noul)) && isNum(a.risk?.score);
  const p = { destructive: a.destructive?.noul ?? 0, exfiltration: a.exfiltration?.noul ?? 0, offtask: a.offtask?.noul ?? 0 };
  const risk = a.risk?.score ?? 0;
  let decision = floor;
  // A guard that cannot read the model's answer must not wave the action through.
  if (!complete) { decision = 'ask'; reasons.push('incomplete model answer'); }
  for (const [k, v] of Object.entries(p)) {
    if (v >= pol.deny && k !== 'offtask') { decision = 'deny'; reasons.push(`${k} ${round(v, 2)}`); }
  }
  if (decision !== 'deny') {
    for (const [k, v] of Object.entries(p)) if (v >= pol.ask) { decision = 'ask'; reasons.push(`${k} ${round(v, 2)}`); }
    if (risk >= pol.riskAsk) { decision = 'ask'; reasons.push(`risk ${round(risk, 1)} of 4`); }
  }
  return { decision, reasons, probabilities: roundMap(p), risk: round(risk, 2), policy: pol, source: 'model', action: clip(action, 300) };
}

// Turn a Claude Code PreToolUse hook payload into an action string.
export function describeToolCall(payload) {
  const name = payload?.tool_name || 'unknown tool';
  const input = payload?.tool_input || {};
  if (name === 'Bash' && input.command) return `Run shell command: ${input.command}`;
  if ((name === 'Write' || name === 'Edit') && input.file_path) {
    const body = String(input.content ?? input.new_string ?? '').slice(0, 800);
    return `${name} file ${input.file_path}${body ? ` with content: ${body}` : ''}`;
  }
  return `${name} with input ${JSON.stringify(input).slice(0, 1500)}`;
}

// ---- 5. grep: filter lines by meaning ----

export async function grep(client, { query, lines, path, threshold = 0.7, invert = false, max = MAX_LINES }) {
  needStr(query, 'query'); needNum(threshold, 'threshold', 0, 1);
  const all = linesFrom({ lines, path });
  const capped = all.slice(0, max);
  const work = capped.map((text, i) => ({ n: i + 1, text })).filter((x) => !blank(x.text));
  const res = await pmap(chunk(work, LINE_BATCH), PARALLEL, async (part) => {
    const state = { lines: part.map((x) => clip(x.text, 600)) };
    const qs = {};
    part.forEach((_, i) => { qs[`l${i}`] = noulQ(`Does \`lines[${i}]\` match this description: ${query}`); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => ({ n: x.n, line: x.text, probability: isNum(a[`l${i}`]?.noul) ? round(a[`l${i}`].noul) : null }));
  });
  const judged = res.flat();
  // A missing answer is unknown, so it appears in neither the matches nor the inverse.
  const matches = judged.filter((r) => r.probability !== null && (invert ? r.probability < threshold : r.probability >= threshold));
  return { matches, scanned: judged.length, unknown: judged.filter((r) => r.probability === null).length, truncated: all.length > capped.length, total: all.length };
}

// ---- 6. rank: order items by a criterion ----

const DEFAULT_LEVELS = ['very low', 'low', 'medium', 'high', 'very high'];

export async function rank(client, { items, path, criterion, levels = DEFAULT_LEVELS, top = null }) {
  needStr(criterion, 'criterion');
  if (!Array.isArray(levels) || levels.length < 2) throw new JevError('levels must be an ordered array of at least two strings', { code: 'bad_input' });
  if (top !== null && (typeof top !== 'number' || top < 1)) throw new JevError('top must be a number of at least 1', { code: 'bad_input' });
  const norm = itemsFrom({ items, path });
  if (!norm.length) throw new JevError('no non-empty items to rank', { code: 'bad_input' });
  const res = await pmap(chunk(norm, ITEM_BATCH), PARALLEL, async (part) => {
    const state = { items: part.map((x) => clip(x.text)) };
    const qs = {};
    part.forEach((_, i) => { qs[`s${i}`] = scoreQ(`Rate \`items[${i}]\` on: ${criterion}`, levels); });
    const a = await client.ask(state, qs);
    return part.map((x, i) => ({ id: x.id, n: x.id, text: x.text, score: isNum(a[`s${i}`]?.score) ? round(a[`s${i}`].score, 1) : null, confidence: round(a[`s${i}`]?.confidence) }));
  });
  const flat = res.flat();
  const scored = flat.filter((x) => x.score !== null).sort((x, y) => y.score - x.score);
  const unscored = flat.filter((x) => x.score === null);
  return {
    max: levels.length - 1,
    ranked: top ? scored.slice(0, top) : scored,
    unscored: unscored.map((x) => x.id),
    note: 'Scores come from a coarse scale and are judged in batches of 8, so treat close scores as ties and compare across batches with care.',
  };
}

// ---- 7. compact: drop lines that no longer matter for a task ----

// Lines that match are always kept, whatever the model says. This protects
// the lines an agent most needs (errors) from a wrong low score.
export const DEFAULT_ALWAYS = '\\b(error|errors|failed|failure|fatal|exception|panic|traceback|assertion|segfault)\\b|\\bERR!|\\bE[A-Z]{3,}\\b';

export async function compact(client, { lines, path, task, threshold = 0.5, context = 1, always = DEFAULT_ALWAYS, max = MAX_LINES }) {
  needStr(task, 'task'); needNum(threshold, 'threshold', 0, 1); needNum(context, 'context', 0, 20);
  const all = linesFrom({ lines, path });
  const capped = all.slice(0, max);
  let alwaysRe = null;
  if (always) {
    if (typeof always !== 'string' || always.length > 300) throw new JevError('always must be a string of at most 300 characters', { code: 'bad_input' });
    // reject nested quantifiers such as (a+)+ , the classic catastrophic-backtracking shape
    if (/(\+|\*|\{\d*,?\d*\})\s*\)\s*(\+|\*|\{)/.test(always)) throw new JevError('always looks like a pattern that can hang. Simplify it.', { code: 'bad_input' });
    try { alwaysRe = new RegExp(always, 'i'); } catch { throw new JevError('always is not a valid regular expression', { code: 'bad_input' }); }
  }
  const work = capped.map((text, i) => ({ i, text })).filter((x) => !blank(x.text));
  const res = await pmap(chunk(work, LINE_BATCH), PARALLEL, async (part) => {
    const state = { task: clip(task, 1000), lines: part.map((x) => clip(x.text, 600)) };
    const qs = {};
    part.forEach((_, i) => { qs[`l${i}`] = noulQ(`Is \`lines[${i}]\` still useful for the work described in \`task\`?`); });
    const a = await client.ask(state, qs);
    // a missing answer keeps the line
    return part.map((x, i) => ({ i: x.i, p: isNum(a[`l${i}`]?.noul) ? a[`l${i}`].noul : 1 }));
  });
  const keep = new Set();
  const pinned = new Set();
  res.flat().forEach((r) => {
    const forced = alwaysRe && alwaysRe.test(String(capped[r.i]).slice(0, 600));
    if (forced) pinned.add(r.i);
    if (r.p >= threshold || forced) for (let d = -context; d <= context; d++) keep.add(r.i + d);
  });
  const kept = [];
  capped.forEach((line, i) => { if (keep.has(i) && !blank(line)) kept.push({ n: i + 1, line }); });
  const tail = all.slice(capped.length).map((line, j) => ({ n: capped.length + j + 1, line }));
  const all_kept = [...kept, ...tail];
  return {
    kept: all_kept,
    text: all_kept.map((k) => k.line).join('\n'),
    keptCount: all_kept.length,
    total: all.length,
    droppedCount: all.length - all_kept.length,
    pinnedCount: pinned.size,
    savedFraction: round(all.length ? (all.length - all_kept.length) / all.length : 0, 2),
    truncated: all.length > capped.length,
  };
}
