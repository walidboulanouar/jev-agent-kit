# 6. PR ranker

Order open pull requests by how urgently they need a reviewer, so the team starts with the one that matters. Scores come from a coarse scale in batches, so treat close scores as ties.

```bash
gh pr list --json title -q '.[].title' | use-cases/pr-ranker/rank-prs.sh
```

## Try it on the sample

```bash
bash use-cases/pr-ranker/run.sh
```

Expected: the security and production-outage items rank near the top, and the cosmetic changes rank near the bottom.

## Notes

- The criterion is a plain-English sentence in `rank-prs.sh`. Change it to match how your team decides.
- `--top N` keeps only the best N.
- Titles alone are a thin signal. Feed in title plus the first lines of the description for better results.
