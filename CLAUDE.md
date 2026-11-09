# CLAUDE.md

## Advisor rule

Consult the `advisor` subagent (Opus 5.5) at exactly these three points:

1. Before a plan locks: after drafting a plan, before ExitPlanMode or any edit.
2. After the same error twice: on the second identical failure.
3. Before a task is marked done: before reporting completion.

Pass the advisor the goal, the plan or error, and what has been tried. Act on its advice, or state why you did not.
