# 2. Build log compactor

Agents waste context on build and test logs. `compact-run.sh` runs any command, then prints only the lines that matter for the task you name, and returns the command's own exit code.

```bash
use-cases/build-log-compactor/compact-run.sh "fix the TypeScript compile error" npm run build
```

Lines that look like errors are always kept, whatever the model says. One line of context is kept around each kept line by default. Edit the script to pass `--around 0` for a tighter cut.

## Try it on the sample log

```bash
bash use-cases/build-log-compactor/run.sh
```

The sample is a 31-line TypeScript build log with two type errors. With `--around 0` (the demo setting) it keeps 17 of 31 lines, which is every relevant line, and drops 14 lines of install noise. With the defaults (one line of context around each kept line) it keeps 24 of 31, so it saves less and reads more safely. The main README has the measurements.

## Why it exists

The model alone kept only 58 percent of the relevant lines on the same fixture. The error pinning and neighbor lines are what make it safe to use, so do not turn them off unless you are measuring.
