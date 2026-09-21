# 5. Semantic log search

A regex needs you to guess the wording. `jev grep` takes a description ("problems with the database") and returns the lines that match its meaning, with line numbers. Chain it into `compact` to give an agent a short, focused view.

```bash
jev grep "problems with the database" --file server.log
jev grep "problems with the database" --raw --file server.log | jev compact "find why writes failed"
```

## Try it on the sample

```bash
bash use-cases/semantic-log-search/run.sh
```

## Honest note

On the maintainer's fixture, `grep` returned only 33 percent of the relevant lines at threshold 0.5, though every line it returned was relevant. It is conservative. Lower `-t` (for example `-t 0.3`) to catch more, and expect more noise. Use it to find leads, not to prove that something is absent.
