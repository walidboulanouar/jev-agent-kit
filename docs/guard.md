# Guard: what it does and does not do

`jev guard` asks Jev four questions about an action: is it destructive, would it leak private data, is it off task, and how risky is it (a 0 to 4 score). It then applies thresholds.

| Result | When | Exit code |
| --- | --- | --- |
| deny | destructive or exfiltration probability at or above 0.85 | 1 |
| ask | any probability at or above 0.4, or risk at or above 2.5 | 2 |
| allow | everything else | 0 |

Change the thresholds with the `policy` argument in the MCP tool. The CLI uses the defaults.

## Design choices

- An unreadable or incomplete model answer gives ask, never allow.
- In hook mode, any failure (network, bad key, bad input) gives ask.
- Off task alone never denies. It can only ask.
- The action text is clipped to 4,000 characters, so a very long command is judged on its start.

## What it is not

It is not a sandbox. It reads the text of an action and estimates risk. A command that hides its effect (an obfuscated script, a file that is run later) can pass. Adversarial text in the action can also steer Jev. Use it as a second opinion next to real permissions, allow lists and sandboxes.
