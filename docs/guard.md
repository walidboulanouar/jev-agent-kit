# Guard: what it does and does not do

`jev guard` judges an action before an agent runs it. It works in two steps.

1. A short list of patterns catches a few catastrophic commands without calling the model: a recursive delete of the root or home folder, formatting a disk, writing raw to a disk device, a fork bomb. These return deny. Another list (piping a download into a shell, a forced git push, recursive world-writable permissions, dropping a database object, touching files that usually hold secrets such as /etc/shadow, .ssh, .aws/credentials or .env) sets a floor of ask. Reading a sensitive file is the model's weakest case, which is why that one is a pattern. The patterns can only tighten a decision. They never allow anything.
2. Jev answers four questions about the action: is it destructive, would it leak private data, is it off task, and how risky is it (a 0 to 4 score). Thresholds turn the answers into a decision.

| Result | When | Exit code |
| --- | --- | --- |
| deny | a catastrophic pattern, or a destructive or exfiltration probability at or above 0.85 | 1 |
| ask | a risky pattern, any probability at or above 0.4, or risk at or above 2.5 | 2 |
| allow | everything else | 0 |

## Design choices

- An unreadable or incomplete model answer gives ask, never allow.
- In hook mode, any failure (network, bad key, bad input) gives ask. The hook prints its decision as JSON and exits 0.
- An action longer than 4,000 characters is judged on its first and last 2,000 characters and can never be allowed outright.
- Off task alone never denies. It can only ask, and it does nothing without `--context` (the CLI) or `context` (MCP). In hook mode there is no user request to compare with, so it is inactive.
- The MCP tool does not accept thresholds. The caller is the agent being guarded, so it must not be able to loosen them. The Node function accepts a `policy` object, and values are clamped so they cannot switch the checks off.
- For Write and Edit calls in hook mode, the file path and the first 800 characters of the content are judged.
- In the CLI, flags (`--context`, `--json`, `--hook`) must come before the action. Everything from the first other word on is the action, byte for byte, so `jev guard cat -f x --hook` judges `cat -f x --hook`. `--hook` cannot be combined with action words.
- The patterns run on a bounded window of the action, and an action over 1 MB is not judged at all (it returns ask).

## What it is not

It is not a sandbox. It reads the text of an action and estimates risk. A command that hides its effect (an obfuscated script, a variable that expands to something dangerous, a file that is run later) can pass. Adversarial text in the action can also steer Jev. Use it as a second opinion next to real permissions, allow lists and sandboxes.

The thresholds (0.85, 0.4 and 2.5) are starting points. They have not been measured on a labeled set of commands, so tune them against your own commands before you rely on them.
