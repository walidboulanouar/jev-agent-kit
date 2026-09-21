# 3. Skill router

An agent with 40 skills should not load them all. `route-skill.sh` reads each skill's description and picks the one that fits a task. When nothing fits, it says so and exits 1, and the agent can ask the user instead of guessing.

```bash
use-cases/skill-router/route-skill.sh "merge these three PDFs into one" path/to/skills
```

## Try it on the sample skills

```bash
bash use-cases/skill-router/run.sh
```

It routes four tasks, including one that matches no skill ("book me a flight to Lisbon"), which should print `no fit`.

## Notes

- A skill named `none` is skipped, because `none` is reserved by `jev route`.
- The router returns a name, not the skill's content. Load the file afterwards.
- With very similar descriptions the model can split its probability. Read `--json` output to see the ranking.
