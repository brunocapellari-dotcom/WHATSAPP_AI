# Claude Code — bounded specialist role

Follow [AGENTS.md](AGENTS.md). Default role is a **single bounded blocker**
or review, not a second always-on executor. Avoid resummarizing the entire
project. Inspect only the named task's files and relevant test failures.

When invoked:
- one deliverable (one root cause, one fix, one targeted test, one commit);
- at most one initial exploration pass and one final verification;
- do not run full CI locally after every minor edit; rely on targeted tests
  and GitHub CI for broader coverage;
- if Oracle access or QR requires a person, record exactly what is missing
  and continue only if a closely related safe task remains;
- avoid launch, provisioning and external sends unless explicitly part of
  the assigned task and within approved safety/cost gates.

Report SHA, test output and remaining blocker. Never claim background
execution or that another agent started automatically.
