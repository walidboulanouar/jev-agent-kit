// Minimal zero-dependency client for TypeSafe's System One API (Jev).
// One request can carry many questions over shared state. Question types:
//   noul   -> probability 0..1
//   choice -> winning option, per-option probabilities, confidence
//   score  -> a value between levels, with a legend and confidence
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export class JevError extends Error {
  constructor(message, { status = null, body = null, code = 'jev_error' } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

// Key lookup order: explicit option, TYPESAFE_API_KEY, JEV_API_KEY, ~/.config/jev/key
export function resolveKey(explicit, env = process.env, home = homedir()) {
  if (explicit) return explicit;
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  if (env.JEV_API_KEY) return env.JEV_API_KEY;
  try {
    const k = readFileSync(join(home, '.config', 'jev', 'key'), 'utf8').trim();
    if (k) return k;
  } catch { /* no key file */ }
  return null;
}

export function noulQ(instructions, criteria = { true: 'yes', false: 'no' }) {
  return { type: 'noul', instructions, criteria };
}
export function choiceQ(instructions, options) {
  const keys = Object.keys(options || {});
  if (keys.length < 2) throw new JevError('choice needs at least two options', { code: 'bad_question' });
  return { type: 'choice', instructions, criteria: options };
}
export function scoreQ(instructions, levels) {
  if (!Array.isArray(levels) || levels.length < 2) throw new JevError('score needs at least two levels', { code: 'bad_question' });
  return { type: 'score', instructions, criteria: levels };
}

export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
    throw new JevError('questions must be a non-empty object', { code: 'bad_question' });
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!q || !['noul', 'choice', 'score'].includes(q.type)) {
      throw new JevError(`question "${name}" has an unknown type`, { code: 'bad_question' });
    }
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
      throw new JevError(`question "${name}" needs instructions`, { code: 'bad_question' });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(opts = {}) {
  const apiKey = resolveKey(opts.apiKey);
  const url = opts.url || process.env.JEV_API_URL || DEFAULT_URL;
  assertSafeUrl(url);
  const model = opts.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetch || globalThis.fetch;
  const stats = { requests: 0, inputTokens: 0, outputTokens: 0 };

  async function ask(state, questions) {
    validateQuestions(questions);
    if (!apiKey) {
      throw new JevError('No API key. Set TYPESAFE_API_KEY or write it to ~/.config/jev/key.', { code: 'no_key' });
    }
    const body = JSON.stringify({ model, state, questions });
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        if (res.ok) {
          const data = await res.json();
          stats.requests += 1;
          stats.inputTokens += data.usage?.input_tokens || 0;
          stats.outputTokens += data.usage?.output_tokens || 0;
          return data.answers || {};
        }
        const text = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new JevError(describeStatus(res.status), { status: res.status, body: text.slice(0, 500), code: statusCode(res.status) });
        if (!retryable || attempt === retries) throw lastErr;
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 400 * 2 ** attempt);
      } catch (err) {
        if (err instanceof JevError) {
          if (!(err.status === 429 || err.status >= 500) || attempt === retries) throw err;
          lastErr = err;
          continue;
        }
        lastErr = new JevError(err.name === 'AbortError' ? `Request timed out after ${timeoutMs} ms` : `Network error: ${err.message}`, { code: 'network' });
        if (attempt === retries) throw lastErr;
        await sleep(400 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  return { ask, stats, model, hasKey: !!apiKey };
}

// The key travels with every request, so refuse to send it over plain http to a remote host.
function assertSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new JevError('Invalid API URL', { code: 'bad_input' }); }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.username || u.password) throw new JevError('API URL must not contain credentials', { code: 'bad_input' });
  if (u.protocol !== 'https:' && !local) {
    throw new JevError('API URL must use https (plain http is allowed only for localhost)', { code: 'bad_input' });
  }
}

function describeStatus(s) {
  if (s === 401) return 'Invalid or missing API key (401)';
  if (s === 422) return 'The API rejected the question format (422)';
  if (s === 429) return 'Rate limited (429)';
  if (s === 529) return 'The API is overloaded (529)';
  return `API error ${s}`;
}
function statusCode(s) {
  if (s === 401) return 'auth';
  if (s === 422) return 'bad_question';
  if (s === 429) return 'rate_limited';
  return 'api';
}

// Run fn over items with a concurrency cap, keeping result order.
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Trim one text to a safe size. Jev reads up to about 32k tokens of state per request.
export function clip(text, max = 1500) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  // cut on code points so a surrogate pair is never split
  return Array.from(s).slice(0, max).join('');
}
