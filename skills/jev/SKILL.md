---
name: jev
description: Use when an agent needs many fast typed decisions (yes/no, pick one, score) about text: routing a task to a model or skill, triaging many items, gating a risky action, filtering or shrinking long logs by meaning, ranking items, or a multi-point done-check. Backed by TypeSafe's Jev model through the jev CLI or MCP tools. Not for writing, summarizing, or math.
---

# Jev decisions for agents

Jev answers questions about text with numbers, not prose. It is worth calling for batches and gates: many lines, many items, or a check that runs often. For one quick judgment you can make yourself, just make it.

## Pick the tool

| You need to | Use |
| --- | --- |
| Answer yes or no about a text | `jev_check` (returns `probability` and `answer`) |
| Choose one of several options | `jev_choose` |
| Rate on a scale | `jev_score` |
| Run several yes/no checks over one text | `jev_judge` (`pass` only if all pass) |
| Send a task to the right model, skill or tool | `jev_route` |
| Label many items | `jev_triage` |
| Decide whether an action is safe to run | `jev_guard` |
| Find lines by meaning | `jev_grep` |
| Order items by quality | `jev_rank` |
| Shrink a long log for the current task | `jev_compact` |
| Anything else | `jev_ask` with your own questions |

## Rules

1. Ask one thing per question. A question that bundles several judgments gets muddy answers. Ask several separate questions in one call instead (`jev_judge` does this).
2. Give options and levels plain-English meanings. Jev reads literally.
3. Branch on the number, using a threshold you chose. Low confidence means unsure, not an answer.
4. Never use it for arithmetic, counting or dates.
5. Pass a `path` to `jev_compact`, `jev_grep`, `jev_triage` and `jev_rank` when the data is in a file. Pasting a log into the call costs as many tokens as the log.
6. Do not send secrets in the text you judge unless the user agreed. The text goes to api.typesafe.ai.

## What to do with each result

- `jev_route` returned `choice: null`: nothing fit. Ask the user or use your default. Do not pick the closest one silently.
- `jev_triage` label is `null`: unsure. Look at `guess`, or ask.
- `jev_guard` says `ask`: stop and check with the user. Never treat `ask` as allow. `deny` means do not run it.
- `jev_guard` is a second opinion, not a security boundary. Keep real permissions in place.
- `jev_compact` keeps error-looking lines and 1 line of context by default. Lines are judged one at a time, so raise `context` for stack traces.
- `jev_rank` scores are coarse. Treat close scores as ties.

## Worked example for jev_ask

```json
{
  "state": { "text": "Refund me now or I will dispute the charge" },
  "questions": {
    "angry": { "type": "noul", "instructions": "Is `text` an angry message?", "criteria": { "true": "angry", "false": "calm" } },
    "kind": { "type": "choice", "instructions": "What does `text` ask for?", "criteria": { "refund": "money back", "info": "information", "other": "anything else" } },
    "urgency": { "type": "score", "instructions": "How urgent is `text`?", "criteria": ["not urgent", "somewhat", "urgent", "critical"] }
  }
}
```

Questions refer to state by name in backticks. `noul` returns a probability, `choice` returns the option with per-option probabilities, `score` returns a number between 0 and the last level.

## From the shell

```bash
cat build.log | jev compact "fix the failing test"
jev triage -o bug="something broken" -o ask="a question" -o idea="a feature request" --file issues.txt
jev guard --context "$USER_REQUEST" "$COMMAND"   # exit 0 allow, 2 ask, 1 deny, 3 error
```

If `jev` is not on the path, use `npx @walidboulanouar/jevkit@0.2.0` (for example `npx @walidboulanouar/jevkit@0.2.0 compact "task"`).
