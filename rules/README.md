# Repository rules

Keep architectural guidance in focused `.mdc` files here. Each file is Markdown
with YAML frontmatter containing a `description` and an `alwaysApply` boolean.
For scoped rules, set `alwaysApply: false` and provide comma-separated,
repository-relative `globs`. For repository-wide rules, set `alwaysApply: true`
and omit `globs`. Use `**` for all descendants of a directory. Include sibling
entry points explicitly when needed.

Root `AGENTS.md` tells coding agents to read matching rules before editing or
reviewing code. This directory is a repository convention: Cursor does not
automatically load it as `.cursor/rules/`, and the `.mdc` extension alone does not
make a tool apply a rule.

The rule body remains here as the single source of truth.

When adding or changing a rule:

1. State the scope, required behavior, examples, exceptions, and review criteria.
2. Verify that the rule's `globs` cover representative files and exclude
   unrelated directories.
3. Keep detailed policy in the rule file instead of copying it into tool settings.

Product behavior is covered by
[`product-harness-responsibility.mdc`](product-harness-responsibility.mdc): routine
work belongs to the harness, and user-facing detail must support an outcome or a
real decision. This applies to orchestration as well as UI.

Background execution is covered by
[`sleep-aware-background-work.mdc`](sleep-aware-background-work.mdc): new or
expanded work must become quiet, use events and real scheduler deadlines, and
preserve recovery across transactions, drain, and restart. This rule covers
`server/src/index.ts` and the worker/producer paths in its scope. It does not
require unrelated legacy polling to be migrated in the same PR.
