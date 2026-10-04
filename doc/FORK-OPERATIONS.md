# Internal Fork Operations

`DF-Studios-App/paperclip` is an internal development fork. Its GitHub Actions
settings intentionally differ from `paperclipai/paperclip`. Do not wait for the
upstream publication or evaluation jobs while working in this fork.

## Project issue and pull request destination

- Make every code change for this fork and push branches only to `origin`.
- Open every new GitHub issue and pull request in
  `DF-Studios-App/paperclip`.
- Target pull requests at the fork's default branch, currently `master`.
- Treat `upstream` (`paperclipai/paperclip`) as read-only reference material.
  Never push there or open issues or pull requests there for this project.
- Verify the repository target before creating an issue or pull request.

## Kept enabled

- `PR` and reusable `Trusted PR CI` for pull request checks.
- `Sentry SDK contract` for changes to its contract files.
- `Refresh Lockfile` after pushes to `master`.

The Docker context integrity lane was removed from `Trusted PR CI` because this
fork does not use Docker.

## Disabled in this fork

- CodeQL default setup.
- Release, package, Docker image, agent runtime image, and cloud migrator
  publication workflows.
- Cloud readiness and Docker Runner checks.
- Storybook publishing and the optional Storybook Visual Actions workflow.
- Runner Full-Stack E2E and Direct Live Protocol Evals.

The recurring schedules were removed from Runner Chaos Evals and Runner Live
Evals. Their manual dispatch/reusable entry points remain in source for
intentional maintenance use; they are not part of routine fork verification.
Agent Runtime Images also has a repository identity guard so pushes in this
fork cannot publish to the upstream GHCR namespace.

GitHub's Actions list may still show a dynamic `CodeQL` row as active. Its
default-setup configuration is `not-configured`, so default CodeQL scanning is
off. The `Commitperclip PR Review` job is restricted to the canonical upstream
repository. `Release Verify` is reusable and has no enabled caller in this
fork.

These changes are fork-specific and do not affect upstream Paperclip. To run a
disabled workflow intentionally, a maintainer must first re-enable it in this
fork's Actions settings and confirm that its credentials, runners, and
publication destinations are appropriate for internal use.

## Skills and runbooks

The local Paperclip runtime skills do not wait for these GitHub Actions runs.
Repository runbooks describing upstream release, cloud, image, evaluation, or
Storybook workflows are reference material only in this fork. Check this page
before waiting for an Actions run or treating a publish task as completed.
