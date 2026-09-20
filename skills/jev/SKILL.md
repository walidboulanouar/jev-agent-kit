---
name: jev
description: Use when an agent needs a fast, cheap typed decision (yes/no, pick one, score) about text: routing a task to a model or skill, triaging many items, gating a risky action, filtering logs by meaning, ranking items, or shrinking a long log. Backed by TypeSafe's Jev model through the jev CLI or MCP tools.
---

# Jev decisions for agents

Jev answers questions about text with numbers, not prose. Use it for judgments you would otherwise spend an LLM call on. Do not use it to write, summarize or do math.

## Pick the tool

| You need to | Use |
| --- | --- |
| Answer yes or no about a text | `jev_check` (probability, threshold in your code) |
| Choose one of several options | `jev_choose` |
| Rate on a scale | `jev_score` |
| Send a task to the right model, skill or tool | `jev_route` (returns null when nothing fits) |
| Label many items | `jev_triage` (null label means unsure) |
| Decide whether an action is safe to run | `jev_guard` (allow, ask, deny) |
| Find lines by meaning | `jev_grep` |
| Order items by quality | `jev_rank` |
| Shrink a long log for the current task | `jev_compact` |
| Anything else | `jev_ask` with your own questions |

## Rules

1. Write questions about one thing each. A question that bundles several judgments gets muddy answers. Ask several separate questions in one call instead.
2. Give options and levels plain-English meanings. Jev reads literally.
3. Branch on the number. Use a threshold you chose, and treat low confidence as "unsure", not as an answer.
4. Never use it for arithmetic, counting or dates.
5. For risky actions, `ask` means stop and check with the user. Never treat `ask` as allow.
6. Do not send secrets in the text you judge unless the user agreed. The text goes to api.typesafe.ai.

## From the shell

```bash
cat build.log | jev compact "fix the failing test"
printf '%s\n' "$ISSUES" | jev triage -o bug="something broken" -o ask="a question" -o idea="a feature request"
jev guard "$COMMAND" --context "$USER_REQUEST"   # exit 0 allow, 2 ask, 1 deny
```
