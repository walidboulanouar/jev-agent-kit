# 4. Issue triage

Label a pile of GitHub issue titles (or emails, tickets, support messages) and print a count per label. Items the model is unsure about are marked `unsure` instead of being forced into a label.

```bash
gh issue list --limit 50 --json title -q '.[].title' | use-cases/issue-triage/triage.sh
```

## Try it on the sample

```bash
bash use-cases/issue-triage/run.sh
```

Expected: each line gets one of `bug`, `question`, `feature` or `docs`, then a count table. Read the labels yourself before you trust them.

## Notes

- Labels are plain English descriptions. Change them in `triage.sh` to fit your project.
- Confidence below 0.5 gives `unsure`. Change it with `--min-confidence`.
- `--jsonl` prints one object per issue with the label, the model's guess and the probabilities, which is what you want for a pipeline.
