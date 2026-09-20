// jev CLI. Reads text from arguments, files or stdin. Prints JSON with --json,
// short readable text otherwise. Exit codes make it usable in pipelines:
//   check:  0 = yes, 1 = no          guard: 0 = allow, 1 = deny, 2 = ask
//   any error: 3
import { readFileSync } from 'node:fs';
import { createClient, JevError } from './client.js';
import * as tools from './tools.js';
import { serve } from './mcp.js';

const HELP = `jev: typed decisions for agents, from TypeSafe's Jev model

Usage: jev <command> [options]

Commands
  check   <question>            yes/no about stdin text. Exit 0 yes, 1 no.
  choose  <question> -o a=meaning -o b=meaning   pick one option for stdin text
  score   <question> -l low,mid,high             rate stdin text on your levels
  route   <task> -c id=description ...           pick a candidate for a task
  triage  -o label=meaning ...                   label each stdin line
  guard   <action> [--context "..."]             allow, ask or deny. Exit 0, 2, 1.
  guard --hook                                   Claude Code PreToolUse hook mode (stdin JSON)
  grep    <description> [--invert] [-t 0.7]      filter stdin lines by meaning
  rank    <criterion> [--top N]                  order stdin lines best to worst
  compact <task> [-t 0.5] [--context N]          keep only lines that matter for a task
  mcp                                            run the MCP server on stdio
  doctor                                         check key and connectivity

Options
  --json      print JSON
  --file, -f  read input from a file instead of stdin
  --help, -h  show this help

Key: set TYPESAFE_API_KEY, or write it to ~/.config/jev/key
`;

function parse(argv) {
  const flags = { o: [], c: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') flags.json = true;
    else if (a === '--invert') flags.invert = true;
    else if (a === '--hook') flags.hook = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-o' || a === '--option') flags.o.push(next());
    else if (a === '-c' || a === '--candidate') flags.c.push(next());
    else if (a === '-l' || a === '--levels') flags.levels = next();
    else if (a === '-t' || a === '--threshold') flags.t = Number(next());
    else if (a === '-f' || a === '--file') flags.file = next();
    else if (a === '--context') flags.context = next();
    else if (a === '--top') flags.top = Number(next());
    else if (a === '--min-confidence') flags.minConf = Number(next());
    else flags._.push(a);
  }
  return flags;
}

function pairs(list, what) {
  const out = {};
  for (const s of list) {
    const i = (s || '').indexOf('=');
    if (i < 1) throw new JevError(`Bad ${what} "${s}". Use name=meaning.`, { code: 'bad_input' });
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

async function readInput(flags) {
  if (flags.file) return readFileSync(flags.file, 'utf8');
  if (process.stdin.isTTY) throw new JevError('No input. Pipe text in or pass --file.', { code: 'bad_input' });
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const linesOf = (text) => text.split('\n').filter((l, i, a) => l.length || i < a.length - 1);

export async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const err = io.err || ((s) => process.stderr.write(s + '\n'));
  const flags = parse(argv);
  const [cmd, ...rest] = flags._;
  if (!cmd || flags.help || cmd === 'help') { out(HELP); return 0; }

  const client = io.client || createClient();
  const emit = (data, pretty) => out(flags.json ? JSON.stringify(data, null, 2) : pretty(data));

  try {
    switch (cmd) {
      case 'mcp':
        await serve(client);
        return 0;
      case 'doctor': {
        if (!client.hasKey) { err('No API key found. Set TYPESAFE_API_KEY or write ~/.config/jev/key'); return 3; }
        const r = await tools.check(client, { text: 'The sky is blue.', question: 'Is this a statement about color?' });
        emit({ ok: true, model: client.model, sample: r }, (d) => `ok. model ${d.model}. sample probability ${d.sample.probability}`);
        return 0;
      }
      case 'check': {
        const text = await readInput(flags);
        const r = await tools.check(client, { text, question: rest.join(' '), threshold: flags.t ?? 0.5 });
        emit(r, (d) => `${d.answer ? 'yes' : 'no'} (${d.probability})`);
        return r.answer ? 0 : 1;
      }
      case 'choose': {
        const text = await readInput(flags);
        const r = await tools.choose(client, { text, question: rest.join(' '), options: pairs(flags.o, 'option') });
        emit(r, (d) => `${d.choice} (${d.confidence})`);
        return 0;
      }
      case 'score': {
        const text = await readInput(flags);
        if (!flags.levels) throw new JevError('score needs -l low,mid,high', { code: 'bad_input' });
        const r = await tools.score(client, { text, question: rest.join(' '), levels: flags.levels.split(',').map((s) => s.trim()) });
        emit(r, (d) => `${d.score}/${d.max} ${d.label} (${d.confidence})`);
        return 0;
      }
      case 'route': {
        const cands = flags.c.length ? pairs(flags.c, 'candidate') : null;
        const r = await tools.route(client, { task: rest.join(' '), candidates: cands, minConfidence: flags.minConf ?? 0.5 });
        emit(r, (d) => (d.choice ? `${d.choice} (${d.confidence})` : `no fit. closest: ${d.ranking.map((x) => `${x.id} ${x.probability}`).join(', ')}`));
        return r.choice ? 0 : 1;
      }
      case 'triage': {
        const items = linesOf(await readInput(flags));
        const r = await tools.triage(client, { items, labels: pairs(flags.o, 'label'), minConfidence: flags.minConf ?? 0.5 });
        emit(r, (d) => d.results.map((x) => `${x.label ?? 'unsure'}\t${items[x.id]}`).join('\n'));
        return 0;
      }
      case 'guard': {
        if (flags.hook) return await guardHook(client, out, err);
        const r = await tools.guard(client, { action: rest.join(' '), context: flags.context || '' });
        emit(r, (d) => `${d.decision}${d.reasons.length ? ': ' + d.reasons.join(', ') : ''}`);
        return { allow: 0, deny: 1, ask: 2 }[r.decision];
      }
      case 'grep': {
        const lines = linesOf(await readInput(flags));
        const r = await tools.grep(client, { query: rest.join(' '), lines, threshold: flags.t ?? 0.7, invert: !!flags.invert });
        emit(r, (d) => d.matches.map((m) => `${m.n}: ${m.line}`).join('\n'));
        return r.matches.length ? 0 : 1;
      }
      case 'rank': {
        const items = linesOf(await readInput(flags));
        const r = await tools.rank(client, { items, criterion: rest.join(' '), top: flags.top || null });
        emit(r, (d) => d.ranked.map((x) => `${x.score}\t${x.text}`).join('\n'));
        return 0;
      }
      case 'compact': {
        const lines = linesOf(await readInput(flags));
        const r = await tools.compact(client, { lines, task: rest.join(' '), threshold: flags.t ?? 0.5, context: Number(flags.context) || 0 });
        emit(r, (d) => d.kept.join('\n'));
        err(`kept ${r.keptCount} of ${r.total} lines`);
        return 0;
      }
      default:
        err(`Unknown command: ${cmd}\n`);
        out(HELP);
        return 3;
    }
  } catch (e) {
    err(e instanceof JevError ? `jev: ${e.message}` : `jev: unexpected error: ${e.message}`);
    return 3;
  }
}

// Claude Code PreToolUse hook. Reads the hook JSON, prints a permission decision.
// Any failure asks the user instead of allowing.
async function guardHook(client, out, err) {
  let payload;
  try { payload = JSON.parse(await readInput({})); } catch { payload = null; }
  let decision = 'ask';
  let reason = 'jev guard could not read the request';
  if (payload) {
    try {
      const r = await tools.guard(client, { action: tools.describeToolCall(payload), context: '' });
      decision = r.decision;
      reason = r.reasons.length ? `jev guard: ${r.reasons.join(', ')}` : 'jev guard: looks safe';
    } catch (e) {
      reason = `jev guard unavailable: ${e.message}`;
      err(reason);
    }
  }
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  return 0;
}
