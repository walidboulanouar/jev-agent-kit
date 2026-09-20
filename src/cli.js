// jev CLI. Reads text from stdin or --file. Prints short readable text, or
// JSON with --json, or one JSON object per line with --jsonl.
//
// Exit codes:
//   0  success (check: yes. guard: allow. route: a choice. grep: matches.)
//   1  a definite "no" (check: no. guard: deny. route: no fit. grep: no matches.)
//   2  guard: ask a human
//   3  error: bad usage, bad input, missing key, network or API failure
import { readFileSync } from 'node:fs';
import { createClient, JevError } from './client.js';
import * as tools from './tools.js';
import { splitLines } from './files.js';
import { serve } from './mcp.js';

const HELP = `jev: typed decisions for agents, from TypeSafe's Jev model

Usage: jev <command> [options]

Commands
  check   <question>                  yes/no about the input text
  choose  <question> -o a=meaning -o b=meaning     pick one option for the input text
  score   <question> -l low,mid,high  rate the input text on your levels
  judge   -q "question" -q "question" run several yes/no checks over the input text
  route   <task> -c id=description -c id=description   pick a candidate for a task
  triage  -o label=meaning -o label=meaning            label each input line
  guard   [--context "..."] [--json] <action...>  allow, ask or deny. Flags go before the action.
  guard   --hook                      Claude Code PreToolUse hook mode (JSON on stdin)
  grep    <description>               keep input lines that match a description
  rank    <criterion>                 order input lines best to worst
  compact <task>                      keep only the input lines that matter for a task
  mcp                                 run the MCP server on stdio
  doctor                              check your key and the connection

Input comes from stdin, or from a file with --file PATH.

Options
  --json           print JSON
  --jsonl          print one JSON object per line (grep, compact, triage, rank)
  --raw            print only the text of each line, no numbers or labels (grep, compact, rank)
  -t, --threshold  probability threshold from 0 to 1 (check 0.5, grep 0.7, compact 0.5, judge 0.5)
  --invert         grep: return the lines that do not match
  --top N          rank: keep the best N
  --around N       compact: also keep N lines around each kept line (default 1)
  --always REGEX   compact: always keep lines matching this (default: error, failed, fatal, ...)
  --min-confidence triage, route: below this the answer is unsure (default 0.5)
  -f, --file PATH  read input from a file
  -h, --help       show this help

Exit codes
  0  yes / allow / a match or a choice
  1  no / deny / no match or no fit
  2  guard: ask a human
  3  error (usage, input, missing key, network, API). Scripts must handle 3 separately from 1.

Key: set TYPESAFE_API_KEY, or write it to ~/.config/jev/key. JEV_MODEL and JEV_API_URL override the defaults.
`;

// Which flags each command accepts. Anything else is an error, except for guard,
// where unknown words belong to the action being judged (for example "cat -f x").
const SPECS = {
  check: { bool: ['json'], val: ['t', 'file'] },
  choose: { bool: ['json'], val: ['file'], multi: ['o'] },
  score: { bool: ['json'], val: ['l', 'file'] },
  judge: { bool: ['json'], val: ['t', 'file'], multi: ['q'] },
  route: { bool: ['json'], val: ['min-confidence'], multi: ['c'] },
  triage: { bool: ['json', 'jsonl'], val: ['min-confidence', 'file'], multi: ['o'] },
  guard: { bool: ['json', 'hook'], val: ['context'], loose: true },
  grep: { bool: ['json', 'jsonl', 'raw', 'invert'], val: ['t', 'file'] },
  rank: { bool: ['json', 'jsonl', 'raw'], val: ['top', 'file'] },
  compact: { bool: ['json', 'jsonl', 'raw'], val: ['t', 'around', 'always', 'file'] },
  mcp: { bool: [], val: [] },
  doctor: { bool: ['json'], val: [] },
};
const ALIASES = { '-t': 't', '--threshold': 't', '-f': 'file', '--file': 'file', '-o': 'o', '--option': 'o', '-c': 'c', '--candidate': 'c', '-l': 'l', '--levels': 'l', '-q': 'q', '--question': 'q' };

function bad(msg) { return new JevError(msg, { code: 'bad_input' }); }

// guard: only --context, --json and --hook are flags, and only before the action.
// Everything from the first other word on is the action, byte for byte, so a
// flag-looking word inside a command can never change what gets judged.
function parseGuard(argv) {
  const flags = { _: [], multi: {} };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--hook') flags.hook = true;
    else if (a === '--context') {
      if (argv[i + 1] === undefined) throw bad('--context needs a value');
      flags.context = argv[++i];
    } else if (a === '--') { i++; break; }
    else break;
  }
  flags._ = argv.slice(i);
  if (flags.hook && flags._.length) throw bad('--hook reads the request from stdin and takes no action words');
  return flags;
}

function parse(cmd, argv) {
  if (cmd === 'guard') return parseGuard(argv);
  const spec = SPECS[cmd];
  const flags = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { flags._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { flags._.push(a); continue; }
    const name = ALIASES[a] || a.replace(/^--?/, '');
    if (spec.bool.includes(name)) { flags[name] = true; continue; }
    if (spec.val.includes(name) || (spec.multi || []).includes(name)) {
      const v = argv[++i];
      if (v === undefined) throw bad(`${a} needs a value`);
      if ((spec.multi || []).includes(name)) (flags.multi[name] ||= []).push(v);
      else flags[name] = v;
      continue;
    }
    if (spec.loose) { flags._.push(a); continue; }
    throw bad(`Unknown option ${a} for "jev ${cmd}". Run jev --help.`);
  }
  return flags;
}

function num(v, name, min, max) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number from ${min} to ${max}`);
  return n;
}

function pairs(list, what, flag) {
  const out = {};
  for (const s of list || []) {
    const i = s.indexOf('=');
    if (i < 1) throw bad(`Bad ${what} "${s}". Use ${flag} name=meaning.`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

async function readInput(file, io) {
  if (file) {
    try { return readFileSync(file, 'utf8'); } catch { throw bad(`cannot read file ${file}`); }
  }
  if (io.stdinTTY ?? process.stdin.isTTY) throw bad('No input. Pipe text in, or pass --file PATH.');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw bad('Input is empty.');
  return text;
}

export async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const err = io.err || ((s) => process.stderr.write(s + '\n'));
  const [cmd, ...rest] = argv;
  if (!cmd) { err('jev: no command given. Run jev --help.'); err(HELP); return 3; }
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') { out(HELP); return 0; }
  if (!SPECS[cmd]) { err(`jev: unknown command "${cmd}". Run jev --help.`); return 3; }
  if (cmd !== 'guard' && (rest.includes('-h') || rest.includes('--help'))) { out(HELP); return 0; }

  try {
    const flags = parse(cmd, rest);
    const client = io.client || createClient();
    const emit = (data, pretty) => out(flags.json ? JSON.stringify(data, null, 2) : pretty(data));
    const words = flags._.join(' ');
    const t = num(flags.t, '-t', 0, 1);
    const minConf = num(flags['min-confidence'], '--min-confidence', 0, 1);
    const inputLines = async () => splitLines(await readInput(flags.file, io));
    const jsonl = (rows) => rows.forEach((r) => out(JSON.stringify(r)));

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
        if (!words) throw bad('check needs a question. Example: jev check "Is this a bug report?" < file.txt');
        const r = await tools.check(client, { text: await readInput(flags.file, io), question: words, threshold: t ?? 0.5 });
        emit(r, (d) => `${d.answer ? 'yes' : 'no'} (${d.probability})`);
        return r.answer ? 0 : 1;
      }
      case 'choose': {
        const options = pairs(flags.multi.o, 'option', '-o');
        if (Object.keys(options).length < 2) throw bad('choose needs at least two -o name=meaning options');
        const r = await tools.choose(client, { text: await readInput(flags.file, io), question: words, options });
        emit(r, (d) => `${d.choice} (${d.confidence})`);
        return 0;
      }
      case 'score': {
        if (!flags.l) throw bad('score needs -l low,mid,high (ordered levels, lowest first)');
        if (!words) throw bad('score needs a question');
        const r = await tools.score(client, { text: await readInput(flags.file, io), question: words, levels: flags.l.split(',').map((s) => s.trim()).filter(Boolean) });
        emit(r, (d) => `${d.score}/${d.max} ${d.label} (${d.confidence})`);
        return 0;
      }
      case 'judge': {
        const qs = flags.multi.q || [];
        if (!qs.length) throw bad('judge needs at least one -q "question"');
        const r = await tools.judge(client, { text: await readInput(flags.file, io), questions: qs, threshold: t ?? 0.5 });
        emit(r, (d) => d.results.map((x) => `${x.pass ? 'pass' : 'FAIL'}\t${x.probability}\t${x.question}`).join('\n') + `\n${d.pass ? 'all passed' : 'not all passed'}`);
        return r.pass ? 0 : 1;
      }
      case 'route': {
        const cands = pairs(flags.multi.c, 'candidate', '-c');
        if (!Object.keys(cands).length) throw bad('route needs at least one -c id=description');
        if (!words) throw bad('route needs a task. Example: jev route "fix the bug" -c code="edits code" -c chat="answers questions"');
        const r = await tools.route(client, { task: words, candidates: cands, minConfidence: minConf ?? 0.5 });
        emit(r, (d) => (d.choice ? `${d.choice} (${d.confidence})` : `no fit. closest: ${d.ranking.map((x) => `${x.id} ${x.probability}`).join(', ')}`));
        return r.choice ? 0 : 1;
      }
      case 'triage': {
        const labels = pairs(flags.multi.o, 'label', '-o');
        if (Object.keys(labels).length < 2) throw bad('triage needs at least two -o label=meaning options');
        const lines = await inputLines();
        const items = lines.map((text, i) => ({ id: i + 1, text })).filter((x) => x.text.trim());
        const r = await tools.triage(client, { items, labels, minConfidence: minConf ?? 0.5 });
        if (flags.jsonl) { jsonl(r.results); return 0; }
        emit(r, (d) => d.results.map((x) => `${x.label ?? `unsure(${x.guess})`}\t${x.text}`).join('\n'));
        return 0;
      }
      case 'guard': {
        if (flags.hook) return await guardHook(client, out, err, io);
        if (!words) throw bad('guard needs an action. Example: jev guard --context "fix a typo" "git reset --hard"');
        const r = await tools.guard(client, { action: words, context: flags.context || '' });
        emit(r, (d) => `${d.decision}${d.reasons.length ? ': ' + d.reasons.join(', ') : ''}`);
        return { allow: 0, deny: 1, ask: 2 }[r.decision];
      }
      case 'grep': {
        if (!words) throw bad('grep needs a description of the lines you want');
        const r = await tools.grep(client, { query: words, lines: await inputLines(), threshold: t ?? 0.7, invert: !!flags.invert });
        if (r.truncated) err(`jev: only the first ${r.scanned} of ${r.total} lines were searched`);
        if (r.unknown) err(`jev: ${r.unknown} lines got no answer and are not in the result`);
        if (flags.jsonl) jsonl(r.matches);
        else if (flags.raw) r.matches.forEach((m) => out(m.line));
        else emit(r, (d) => d.matches.map((m) => `${m.n}: ${m.line}`).join('\n'));
        return r.matches.length ? 0 : 1;
      }
      case 'rank': {
        if (!words) throw bad('rank needs a criterion');
        const lines = await inputLines();
        const items = lines.map((text, i) => ({ id: i + 1, text })).filter((x) => x.text.trim());
        const r = await tools.rank(client, { items, criterion: words, top: flags.top !== undefined ? num(flags.top, '--top', 1, 1e6) : null });
        if (flags.jsonl) jsonl(r.ranked);
        else if (flags.raw) r.ranked.forEach((x) => out(x.text));
        else emit(r, (d) => d.ranked.map((x) => `${x.score}\t${x.text}`).join('\n'));
        if (r.unscored.length) err(`jev: ${r.unscored.length} lines got no score`);
        return 0;
      }
      case 'compact': {
        if (!words) throw bad('compact needs the task you are working on');
        const r = await tools.compact(client, {
          lines: await inputLines(), task: words, threshold: t ?? 0.5, context: num(flags.around, '--around', 0, 20) ?? 1,
          ...(flags.always !== undefined ? { always: flags.always } : {}),
        });
        if (flags.jsonl) jsonl(r.kept);
        else if (flags.raw || !flags.json) out(r.text);
        else emit(r, () => '');
        err(`jev: kept ${r.keptCount} of ${r.total} lines${r.pinnedCount ? `, ${r.pinnedCount} pinned by the always pattern` : ''}`);
        return 0;
      }
      default:
        return 3;
    }
  } catch (e) {
    err(e instanceof JevError ? `jev: ${e.message}` : `jev: unexpected error: ${e.message}`);
    return 3;
  }
}

// Claude Code PreToolUse hook. Reads the hook JSON, prints a permission decision.
// Any failure asks the user instead of allowing. Exit code is always 0 because
// the decision travels in the JSON.
async function guardHook(client, out, err, io) {
  let payload = null;
  try { payload = JSON.parse(await readInput(undefined, io)); } catch { payload = null; }
  let decision = 'ask';
  let reason = 'jev guard could not read the request';
  if (payload && typeof payload === 'object') {
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
