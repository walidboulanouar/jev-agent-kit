# Six use cases

Each folder is a complete, runnable use case built on the jev tools. Every one has a `run.sh`, sample data in `sample/`, and a README that says what it does, the exact commands, and what to expect. They call `node bin/jev.js` from this repo, so nothing else needs installing. Set `TYPESAFE_API_KEY` first.

| # | Use case | Tool | What it does |
| --- | --- | --- | --- |
| 1 | [guard-claude-code](guard-claude-code) | `guard --hook` | Stops risky tool calls in Claude Code before they run, and never auto-approves |
| 2 | [build-log-compactor](build-log-compactor) | `compact` | Runs a command and hands the agent only the lines that matter |
| 3 | [skill-router](skill-router) | `route` | Picks which skill folder to load for a task, or says none fits |
| 4 | [issue-triage](issue-triage) | `triage` | Labels a pile of issues or emails and prints a count per label |
| 5 | [semantic-log-search](semantic-log-search) | `grep` | Finds lines by meaning, then shrinks the result for an agent |
| 6 | [pr-ranker](pr-ranker) | `rank` | Orders pull requests by how urgently they need review |

Run all six against the sample data:

```bash
export TYPESAFE_API_KEY=your_key
for d in use-cases/*/; do echo "== $d"; bash "$d/run.sh"; done
```

Each run makes a handful of requests. A full pass costs a fraction of a cent.

The samples are small and written for the demos, so read the output as an illustration and not as a benchmark. See the main README for what was measured.
