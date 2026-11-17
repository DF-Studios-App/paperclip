# Deferred migration statements

`next-release-triggers.sql` holds statements that were split out of migrations
0372, 0378 and 0415. They are **not** in the migrations journal, and the
migrator never reads this folder. Nothing here runs when the server starts.

## Why these statements were deferred

The release before this one keeps running while the migration runs. The
statements below either replace a function that the running release calls,
attach a trigger to a table the running release writes to, or change a column
default the running release relies on. The migration compatibility guard
classifies each of these as `unknown` (`replace_function`,
`create_trigger_existing_table`, `set_default`), so they cannot ship in a
migration that passes the guard without a human override. Deferring them keeps
the migrations in this release online-compatible.

## What the file contains (17 statements, in order)

1. Functions for the 0415 package-deletion queue (`paperclip_queue_skill_package_deletion`, `paperclip_schedule_skill_package_cleanup`), created with `CREATE OR REPLACE`.
2. `ALTER COLUMN ... SET DEFAULT '[]'` on `company_skill_repository_snapshots.file_inventory` (0415).
3. Replaced functions from 0378: `paperclip_invalidate_skill_source_runtimes` and `paperclip_skill_runtime_changed`.
4. Four triggers from 0378 on `environments`, `plugins`, `plugin_company_settings` and `instance_settings`.
5. Two restore-point triggers from 0372 on `issues` (`paperclip_restore_point_tree_update`, `paperclip_restore_point_tree_delete`).
6. Three `DROP TRIGGER IF EXISTS` and `CREATE TRIGGER` pairs from 0415 on `skill_package_deletion_receipts`, `skill_package_current_cleanup` and `skill_package_version_cleanup`.

Each statement has a `-- From 00xx` note above it. The functions that stay in
the listed migrations (for example `paperclip_restore_point_tree_changed`,
`paperclip_environment_selects_runtime_skill`, `paperclip_environment_runtimes_changed`)
are not in this file.

## Behavior until the statements ship

Until the next release applies this file, these behaviors are not enforced by
the database:

- Restore-point tree-change tracking on `issues` does not run.
- Skill runtime invalidation on environment, plugin and instance-setting changes does not run.
- Package-deletion receipts and cleanup scheduling do not run, so archived skill packages are not queued for deletion.
- `file_inventory` has no database default. The application must supply the value on insert.

On Windows, three server suites (`skill-package-work`, `runtime-skill-preservation`,
`skill-package-store`) fail with the same 49 of 63 tests both at HEAD and with this
change, so the deferral does not change their result there. The Linux CI run is the
check for them; see the PR description.

## How to ship these statements (next release)

1. Move each block into a new migration file under `packages/db/src/migrations/`.
2. Add the journal entry with `pnpm db:generate` and the migration to the list in `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` only if it needs top-level statements.
3. Run `cd packages/db && pnpm exec tsx scripts/migration-compatibility.ts --check`. Classify the statements, or write an override that names what the running release does during the migration.
4. Delete the moved statements from this file. Do not keep both copies.
