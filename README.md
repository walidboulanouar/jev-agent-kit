# jev-agent-kit

Small command line and MCP tools that give agents fast, typed decisions from [TypeSafe's Jev model](https://typesafe.ai). One binary, no dependencies, Node 18 or newer.

Jev does not write text. It answers questions about text with a number: a probability for yes or no, a pick among options with a confidence, or a score between levels. That makes it a good judge inside an agent loop: cheap, fast, and easy to branch on. This kit wraps it in ten tools an agent can call, and the same tools work in a shell pipeline.

Unofficial. Not affiliated with TypeSafe AI.

## Install

```bash
git clone https://github.com/walidboulanouar/jev-agent-kit
cd jev-agent-kit
export TYPESAFE_API_KEY=your_key      # or write the key to ~/.config/jev/key
node bin/jev.js doctor                # checks your key
```

To get `jev` on your path, run `npm link` inside the folder. The package has no dependencies, so there is nothing else to install.

## The tools

| Command | MCP tool | What it does |
| --- | --- | --- |
| `jev check` | `jev_check` | Yes or no about a text. Exit code 0 for yes, 1 for no. |
| `jev choose` | `jev_choose` | Pick one option for a text. |
| `jev score` | `jev_score` | Rate a text on levels you define. |
| `jev route` | `jev_route` | Pick the best model, skill or tool for a task. Abstains when nothing fits. |
| `jev triage` | `jev_triage` | Label many items (emails, issues, tickets, log lines). |
| `jev guard` | `jev_guard` | Judge an action before an agent runs it: allow, ask or deny. |
| `jev grep` | `jev_grep` | Filter lines by meaning instead of by pattern. |
| `jev rank` | `jev_rank` | Order items best to worst on a criterion. |
| `jev compact` | `jev_compact` | Cut a long log down to the lines that still matter for a task. |
| `jev mcp` | (server) | Run all of the above as an MCP server on stdio. |
| none | `jev_ask` | Raw access: send your own state and questions. |

## Use it from Claude Code

Add the MCP server:

```bash
claude mcp add jev -e TYPESAFE_API_KEY=your_key -- node /path/to/jev-agent-kit/bin/jev.js mcp
```

Then ask Claude to use it: "use jev_route to pick which of these three skills fits this task" or "use jev_compact to shrink this build log to what matters for the failing test".

Any MCP client works. The server speaks newline-delimited JSON-RPC on stdio and supports protocol versions 2025-06-18, 2025-03-26 and 2024-11-05.

## Examples

Route a task:

```bash
jev route "write a 2000 word essay with careful reasoning" \
  -c fast="cheap quick model for simple lookups" \
  -c deep="strong model for long careful reasoning"
# deep (1)
```

Triage lines from stdin:

```bash
printf 'Your invoice #4432 is overdue\nCan we meet Thursday?\nBUY CHEAP WATCHES NOW!!!\n' \
  | jev triage -o billing="payments and invoices" -o meeting="scheduling" -o spam="junk"
# billing   Your invoice #4432 is overdue
# meeting   Can we meet Thursday?
# spam      BUY CHEAP WATCHES NOW!!!
```

Search by meaning:

```bash
cat server.log | jev grep "problems or failures"
# 2: ERROR: connection refused to db
# 4: fatal: out of memory
```

Compact a build log for an agent:

```bash
npm run build 2>&1 | jev compact "fix the TypeScript compile error"
# ERROR TS2322 in src/a.ts line 4
# kept 1 of 5 lines
```

Rank by a criterion:

```bash
jev rank "how concrete and specific the claim is" --top 3 < claims.txt
```

Gate an action in a script. Exit codes are 0 for allow, 1 for deny and 2 for ask:

```bash
jev guard "delete every file in the home directory" --context "user asked to fix a typo"
# deny: destructive 0.97
```

Add `--json` to any command for machine-readable output.

## Guard as a Claude Code hook

`jev guard --hook` reads a Claude Code PreToolUse payload from stdin and prints a permission decision. If the API is down or the payload is unreadable, it asks instead of allowing. To try it, add this to `.claude/settings.json` in a project you want guarded:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/jev-agent-kit/bin/jev.js guard --hook" }] }
    ]
  }
}
```

It costs one API request per matching tool call, so keep the matcher narrow. Read [docs/guard.md](docs/guard.md) first.

## Behavior you can rely on

- The API key is read from `TYPESAFE_API_KEY`, `JEV_API_KEY` or `~/.config/jev/key`. It is never printed and never written by this tool.
- Requests retry on 429 and 5xx with backoff, and time out after 20 seconds.
- Batch tools send several questions per request (8 items for triage and rank, 25 lines for grep and compact) and run up to 4 requests in parallel.
- Texts are clipped before sending (1,500 characters per item, 600 per line) to stay inside Jev's 32k token limit.
- Tools that drop things (`compact`, `grep`) keep line order and report counts. If a model answer is missing, `compact` keeps the line and `guard` asks.

## Limits

Jev reads literally, is weak at math, counting and dates, and gets less accurate when the state has irrelevant text in it. Read [TypeSafe's limits page](https://docs.typesafe.ai/model-jaggedness/jev-1.13) before you trust a probability. Treat scores as a ranking signal, not a measurement. `guard` reduces risk. It is not a security boundary, and a determined prompt can steer any model, so keep real permissions in code.

Cost is TypeSafe's input token price, about $0.042 per million tokens as of 2026-09-19. Check current pricing.

## Develop

```bash
node --test          # 21 tests, offline, against a fake API
```

Tests run against a local mock of the API, so they cost nothing and need no key.

## Related

See the [awesome-jev-use-cases](https://github.com/walidboulanouar/awesome-jev-use-cases) list for what others have built with Jev. Sponsored by [AY Automate](https://ayautomate.com).

## License

MIT
