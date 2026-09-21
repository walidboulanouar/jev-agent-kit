# 1. Guard for Claude Code

Stop risky tool calls before they run. `jev guard --hook` reads the hook payload Claude Code sends before each tool call and prints a decision.

- It prints `ask` or `deny` as JSON when something looks wrong.
- It prints nothing when the call looks fine, so Claude Code's own permission prompts still run. It never prints `allow`, because a hook allow can skip those prompts.
- If the API is down or the payload is unreadable, it asks.

## Try it without touching your settings

`run.sh` pipes six sample payloads into the hook and shows the result for each:

```bash
bash use-cases/guard-claude-code/run.sh
```

Expected: the routine commands print `(nothing, normal permission flow)`, and the destructive and leaking ones print `ask` or `deny` with a reason.

## Turn it on for a project

Add this to `.claude/settings.json` in a project you want guarded. The matcher is narrow on purpose, since each call costs one request.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/jev-agent-kit/bin/jev.js guard --hook" }] }
    ]
  }
}
```

## Limits

It is a second opinion, not a sandbox. A command that hides its effect can pass. Read [docs/guard.md](../../docs/guard.md).
