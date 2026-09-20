// A tiny fake of the System One API so tests run offline and free.
// Rules: text with "[T]" -> noul 0.95, "[M]" -> 0.5, else 0.05.
// choice picks the option whose name appears in the text, else the first option.
// score = number of "!" in the text, capped at the top level.
import { createServer } from 'node:http';

function resolve(instr, state) {
  const m = instr.match(/`(\w+)(?:\[(\d+)\])?`/);
  if (!m) return '';
  const v = state?.[m[1]];
  return String(Array.isArray(v) ? v[Number(m[2])] : v ?? '');
}

export function answer(state, questions) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const text = resolve(q.instructions, state);
    if (q.type === 'noul') {
      answers[name] = { type: 'noul', noul: text.includes('[T]') ? 0.95 : text.includes('[M]') ? 0.5 : 0.05 };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const hit = keys.find((k) => text.toLowerCase().includes(k.toLowerCase())) || keys[0];
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === hit ? 0.9 : 0.1 / (keys.length - 1)]));
      answers[name] = { type: 'choice', choice: hit, confidence: 0.9, probabilities };
    } else {
      const top = q.criteria.length - 1;
      const s = Math.min((text.match(/!/g) || []).length, top);
      answers[name] = { type: 'score', score: s, confidence: 0.9, legend: {}, probabilities: {} };
    }
  }
  return answers;
}

export async function startMock({ failFirst = 0, status = 500, drop = null } = {}) {
  let failures = failFirst;
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end('bad key'); return; }
      if (failures > 0) { failures--; res.writeHead(status).end('fail'); return; }
      const { state, questions } = JSON.parse(body);
      const answers = answer(state, questions);
      if (drop) for (const k of Object.keys(answers)) if (k.startsWith(drop)) delete answers[k];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  return { url, seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}
