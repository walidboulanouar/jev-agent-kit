// A small MCP server over stdio. Messages are newline-delimited JSON-RPC 2.0.
// stdout carries protocol messages only. Logs go to stderr.
import { createInterface } from 'node:readline';
import * as tools from './tools.js';
import { JevError } from './client.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'jev-agent-kit', version: '0.1.0' };

const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const strList = (d) => ({ type: 'array', items: { type: 'string' }, description: d });

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
    inputSchema: { type: 'object', properties: { text: str('The text to classify'), question: str('What is being decided'), options: { type: 'object', description: 'Map of option name to meaning', additionalProperties: { type: 'string' } } }, required: ['text', 'options'] },
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
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: {}, text: { type: 'string' } }, required: ['text'] }] } }, labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of label to meaning' }, minConfidence: num('Default 0.5') }, required: ['items', 'labels'] },
    run: (c, a) => tools.triage(c, a),
  },
  {
    name: 'jev_guard',
    description: 'Judge an action before an agent runs it. Returns allow, ask or deny with reasons. It asks a human when unsure and never allows on an unreadable answer.',
    inputSchema: { type: 'object', properties: { action: str('What is about to run, for example a shell command'), context: str('What the user asked for'), policy: { type: 'object', description: 'Optional thresholds: deny, ask, riskAsk' } }, required: ['action'] },
    run: (c, a) => tools.guard(c, a),
  },
  {
    name: 'jev_grep',
    description: 'Filter lines by meaning instead of by pattern. Returns matching lines with line numbers and probabilities.',
    inputSchema: { type: 'object', properties: { query: str('Describe what the lines should be about'), lines: strList('Lines to search'), threshold: num('Default 0.7'), invert: { type: 'boolean', description: 'Return the lines that do not match' } }, required: ['query', 'lines'] },
    run: (c, a) => tools.grep(c, a),
  },
  {
    name: 'jev_rank',
    description: 'Order items from best to worst on a criterion. Returns each item with a score and confidence.',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: {}, text: { type: 'string' } }, required: ['text'] }] } }, criterion: str('What good looks like'), levels: strList('Optional ordered levels, lowest first'), top: num('Return only the top N') }, required: ['items', 'criterion'] },
    run: (c, a) => tools.rank(c, a),
  },
  {
    name: 'jev_compact',
    description: 'Cut a long log or tool output down to the lines that still matter for a task. Keeps order. Returns the kept lines and how much was dropped.',
    inputSchema: { type: 'object', properties: { lines: strList('The lines to compact'), task: str('What the agent is working on'), threshold: num('Keep lines at or above this relevance. Default 0.5'), context: num('Also keep this many lines around each kept line') }, required: ['lines', 'task'] },
    run: (c, a) => tools.compact(c, a),
  },
  {
    name: 'jev_ask',
    description: 'Raw access. Send your own state and questions (noul, choice, score) to the Jev API in one request.',
    inputSchema: { type: 'object', properties: { state: { description: 'Any JSON the questions refer to' }, questions: { type: 'object', description: 'Map of name to {type, instructions, criteria}' } }, required: ['questions'] },
    run: (c, a) => tools.ask(c, a),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(client, name, args) {
  const tool = byName.get(name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
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
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
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
      return ok(await callTool(client, params.name, params.arguments));
    }
    default:
      // notifications carry no id and get no reply
      if (!isRequest) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

export function serve(client, { input = process.stdin, output = process.stdout, errput = process.stderr } = {}) {
  const rl = createInterface({ input });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const p = handle(client, msg).then((reply) => {
      if (reply) output.write(JSON.stringify(reply) + '\n');
    }).catch((err) => {
      errput.write(`jev-mcp error: ${err.message}\n`);
      if (msg.id !== undefined && msg.id !== null) output.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }) + '\n');
    }).finally(() => pending.delete(p));
    pending.add(p);
  });
  // Exit only after in-flight requests have replied.
  return new Promise((resolve) => rl.on('close', async () => { await Promise.all(pending); resolve(); }));
}
