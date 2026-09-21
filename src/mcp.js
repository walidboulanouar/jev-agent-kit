// A small MCP server over stdio. Messages are newline-delimited JSON-RPC 2.0.
// stdout carries protocol messages only. Logs go to stderr.
import { createInterface } from 'node:readline';
import * as tools from './tools.js';
import { JevError } from './client.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'jevkit', version: '0.2.0' };

const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const strList = (d) => ({ type: 'array', items: { type: 'string' }, description: d });
const pathProp = str('Path to a text file inside the working directory. The server reads it, so you do not have to paste the content. Give either this or the inline list, not both.');

export const TOOLS = [
  {
    name: 'jev_check',
    description: 'Yes or no question about a text. Returns a probability from 0 to 1. Fast and cheap. Use for gates and filters.',
    inputSchema: { type: 'object', properties: { text: str('The text to judge'), question: str('A yes or no question about the text'), threshold: num('Probability at or above which answer is true. Default 0.5') }, required: ['text', 'question'] },
    run: (c, a) => tools.check(c, a),
  },
  {
    name: 'jev_choose',
    description: 'Pick one option for a text. Options is an object mapping option name to a plain-English meaning. Returns the choice, a probability per option and a confidence.',
    inputSchema: { type: 'object', properties: { text: str('The text to classify'), question: str('What is being decided'), options: { type: 'object', description: 'Map of option name to meaning', additionalProperties: { type: 'string' } }, minConfidence: num('Below this confidence the choice is null. Default 0') }, required: ['text', 'options'] },
    run: (c, a) => tools.choose(c, a),
  },
  {
    name: 'jev_score',
    description: 'Rate a text on a scale you define. Levels is an ordered list from lowest to highest. The score can land between levels.',
    inputSchema: { type: 'object', properties: { text: str('The text to rate'), question: str('What to rate'), levels: strList('Ordered levels, lowest first') }, required: ['text', 'question', 'levels'] },
    run: (c, a) => tools.score(c, a),
  },
  {
    name: 'jev_route',
    description: 'Pick the best candidate (model, skill, tool, agent) for a task. Returns null when nothing fits or confidence is low.',
    inputSchema: { type: 'object', properties: { task: str('The task to route'), candidates: { type: 'array', description: 'Candidates as strings or {id, description}', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } }, required: ['id'] }] } }, k: num('How many ranked options to return'), minConfidence: num('Below this the result abstains. Default 0.5') }, required: ['task', 'candidates'] },
    run: (c, a) => tools.route(c, a),
  },
  {
    name: 'jev_triage',
    description: 'Label many items at once (emails, issues, tickets, logs). Labels is an object mapping label name to meaning. Items with low confidence get a null label.',
    inputSchema: { type: 'object', properties: { path: pathProp, items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: {}, text: { type: 'string' } }, required: ['text'] }] } }, labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of label to meaning' }, minConfidence: num('Default 0.5') }, required: ['labels'] },
    run: (c, a) => tools.triage(c, a),
  },
  {
    name: 'jev_guard',
    description: 'A second opinion on an action before an agent runs it. Returns allow, ask or deny with reasons. It asks a human when unsure, never allows on an unreadable answer, and blocks a few catastrophic patterns without calling the model. If the result is ask, stop and check with the user. It is a second opinion, not a security boundary.',
    inputSchema: { type: 'object', properties: { action: str('What is about to run, for example a shell command'), context: str('What the user asked for. Without it the off-task check does nothing.') }, required: ['action'] },
    // thresholds are not exposed here: the caller is the agent being guarded
    run: (c, a) => tools.guard(c, { action: a.action, context: a.context }),
  },
  {
    name: 'jev_grep',
    description: 'Filter lines by meaning instead of by pattern. Returns matching lines with 1-based line numbers and probabilities. Prefer path over pasting lines.',
    inputSchema: { type: 'object', properties: { query: str('Describe what the lines should be about'), path: pathProp, lines: strList('Lines to search, if no path'), threshold: num('Default 0.7'), invert: { type: 'boolean', description: 'Return the lines that do not match' } }, required: ['query'] },
    run: (c, a) => tools.grep(c, a),
  },
  {
    name: 'jev_rank',
    description: 'Order items from best to worst on a criterion. Scores are coarse and judged in batches of 8, so treat close scores as ties. Returns each item with a score and confidence.',
    inputSchema: { type: 'object', properties: { path: pathProp, items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: {}, text: { type: 'string' } }, required: ['text'] }] } }, criterion: str('What good looks like'), levels: strList('Optional ordered levels, lowest first'), top: num('Return only the top N') }, required: ['criterion'] },
    run: (c, a) => tools.rank(c, a),
  },
  {
    name: 'jev_compact',
    description: 'Cut a long log or tool output down to the lines that still matter for a task. Keeps order and original 1-based line numbers. Lines that look like errors are always kept. Prefer path over pasting lines, because pasting costs as many tokens as the log.',
    inputSchema: { type: 'object', properties: { path: pathProp, lines: strList('The lines to compact, if no path'), task: str('What the agent is working on'), threshold: num('Keep lines at or above this relevance. Default 0.5'), context: num('Also keep this many lines around each kept line. Default 1'), alwaysWords: strList('Words that force a line to be kept whatever the model says (matched as plain text, case-insensitive). Default keeps lines with error, failed, fatal, exception, panic, traceback. Pass an empty list to turn this off.') }, required: ['task'] },
    run: (c, a) => {
      const { alwaysWords, always, ...rest } = a; // no caller-supplied regex over MCP
      if (Array.isArray(alwaysWords)) {
        const esc = alwaysWords.filter((w) => typeof w === 'string' && w).slice(0, 50).map((w) => w.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        rest.always = esc.join('|');
      }
      return tools.compact(c, rest);
    },
  },
  {
    name: 'jev_judge',
    description: 'Run several yes/no checks over one text in a single request. pass is true only if every check passes. Use it as a cheap done-check or output validator.',
    inputSchema: { type: 'object', properties: { text: str('The text to check'), questions: strList('Yes/no questions about the text, at most 20. Each should test one thing.'), threshold: num('A check passes at or above this probability. Default 0.5') }, required: ['text', 'questions'] },
    run: (c, a) => tools.judge(c, a),
  },
  {
    name: 'jev_ask',
    description: 'Raw access. Send your own state and questions to the Jev API in one request. Questions refer to state by name in backticks, for example `text`. Types: noul (yes/no probability; criteria {"true":"...","false":"..."}), choice (criteria is an object mapping option to meaning), score (criteria is an ordered array of level names). Example: {"state":{"text":"hi"},"questions":{"polite":{"type":"noul","instructions":"Is `text` polite?","criteria":{"true":"polite","false":"rude"}}}}',
    inputSchema: { type: 'object', properties: { state: { description: 'Any JSON the questions refer to' }, questions: { type: 'object', description: 'Map of name to {type, instructions, criteria}', additionalProperties: { type: 'object', properties: { type: { type: 'string', enum: ['noul', 'choice', 'score'] }, instructions: { type: 'string' }, criteria: {} }, required: ['type', 'instructions'] } } }, required: ['questions'] },
    run: (c, a) => tools.ask(c, a),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(client, name, args) {
  const tool = byName.get(name);
  if (!tool) return null;
  try {
    const result = await tool.run(client, args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof JevError ? `${err.message}${err.status ? ` (status ${err.status})` : ''}` : `Unexpected error: ${err.message}`;
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}

// Pure request handler, so tests can call it without a process.
export async function handle(client, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  // A notification carries no id and gets no reply. Never run tools for one.
  if (!isRequest) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      const version = SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0];
      return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: listTools() });
    case 'tools/call': {
      if (!params?.name) return fail(-32602, 'Missing tool name');
      {
        const r = await callTool(client, params.name, params.arguments);
        if (r === null) return fail(-32602, `Unknown tool: ${params.name}`);
        return ok(r);
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export function serve(client, { input = process.stdin, output = process.stdout, errput = process.stderr } = {}) {
  const rl = createInterface({ input });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (line.length > 5_000_000) {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }) + '\n');
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const p = handle(client, msg).then((reply) => {
      if (reply) output.write(JSON.stringify(reply) + '\n');
    }).catch((err) => {
      errput.write(`jev-mcp error: ${err.message}\n`);
      if (msg?.id !== undefined && msg?.id !== null) output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }) + '\n');
    }).finally(() => pending.delete(p));
    pending.add(p);
  });
  // Exit only after in-flight requests have replied.
  return new Promise((resolve) => rl.on('close', async () => { await Promise.all(pending); resolve(); }));
}
