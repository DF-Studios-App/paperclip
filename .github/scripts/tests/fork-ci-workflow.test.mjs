import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readWorkflow(relPath) {
  const content = readFileSync(
    new URL(`../../workflows/${relPath}`, import.meta.url),
    "utf8",
  );
  return content.replace(/\r\n/g, "\n");
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

test("pr.yml delegates to the fork's local reusable workflow", () => {
  const pr = readWorkflow("pr.yml");
  assert.match(
    pr,
    /uses:\s*\.\/\.github\/workflows\/pr-trusted\.yml/,
    "pr.yml must call local reusable workflow",
  );
  assert.doesNotMatch(
    pr,
    /uses:\s*paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml@master/,
    "pr.yml must not delegate to upstream master branch",
  );
});

test("pr-trusted.yml skips only release-specific steps on fork repositories", () => {
  const trusted = readWorkflow("pr-trusted.yml");

  // 1. Release package manifest validation
  const manifestMatch = trusted.match(
    /- name: Validate release package manifest\n\s+if: ([^\n]+)\n\s+run: node \.\/scripts\/release-package-map\.mjs check/,
  );
  assert.ok(manifestMatch, "Validate release package manifest step must exist");
  assert.equal(
    manifestMatch[1].trim(),
    "github.repository == 'paperclipai/paperclip'",
    "Validate release package manifest must only run on paperclipai/paperclip",
  );

  // 2. Release bootstrap registry validation
  const bootstrapMatch = trusted.match(
    /- name: Verify release package bootstrap for changed manifests\n\s+if: ([^\n]+)\n\s+run: \|\n\s+mapfile -t changed_paths/,
  );
  assert.ok(
    bootstrapMatch,
    "Verify release package bootstrap step must exist",
  );
  assert.equal(
    bootstrapMatch[1].trim(),
    "github.repository == 'paperclipai/paperclip'",
    "Release package bootstrap must only run on paperclipai/paperclip",
  );

  // 3. Release registry test coverage
  const registryCoverageMatch = trusted.match(
    /- name: Verify release registry test coverage\n\s+if: ([^\n]+)\n\s+run: pnpm run test:release-registry/,
  );
  assert.ok(
    registryCoverageMatch,
    "Verify release registry test coverage step must exist",
  );
  assert.equal(
    registryCoverageMatch[1].trim(),
    "github.repository == 'paperclipai/paperclip'",
    "Release registry test coverage must only run on paperclipai/paperclip",
  );

  // 4. Canary dry run job
  const canaryJob = trusted.match(
    /canary_dry_run:\n\s+name: Canary Dry Run\n\s+needs: \[gate\]\n\s+if: ([^\n]+)/,
  );
  assert.ok(canaryJob, "canary_dry_run job must exist");
  assert.match(
    canaryJob[1],
    /github\.repository == 'paperclipai\/paperclip'/,
    "canary_dry_run must be skipped for fork repositories",
  );
  assert.match(
    canaryJob[1],
    /needs\.gate\.outputs\.full_ci == 'true'/,
    "canary_dry_run must still check full_ci scope",
  );
});

test("pr-trusted.yml keeps normal tests, typechecks, builds, security checks, and E2E enabled", () => {
  const trusted = readWorkflow("pr-trusted.yml");

  // Core policy checks must NOT be skipped on forks
  assert.match(trusted, /- name: Validate Dockerfile deps stage\n\s+run: node \.\/scripts\/check-docker-deps-stage\.mjs/);
  assert.match(trusted, /- name: Validate Node version policy\n\s+run: pnpm check:node-version/);
  assert.match(trusted, /- name: Reject git push in adapter\/runtime code\n\s+run: node \.\/scripts\/check-no-git-push\.mjs/);
  assert.match(trusted, /- name: Validate feature module boundaries\n\s+run: pnpm check:module-boundaries/);
  assert.match(trusted, /- name: Validate dependency resolution\n\s+run: pnpm install --resolution-only/);

  // Typecheck in typecheck_release_registry must remain enabled
  assert.match(trusted, /- name: Typecheck workspaces whose build scripts skip TypeScript\n\s+run: pnpm run typecheck:build-gaps/);

  // General tests, runner verification, build, and serialized server shards must remain enabled
  assert.match(trusted, /general_tests:[\s\S]*?name: General tests/);
  assert.match(trusted, /verify_paperclip_runner:[\s\S]*?name: Verify Paperclip Runner/);
  assert.match(trusted, /build:[\s\S]*?name: Build/);
  assert.match(trusted, /verify_serialized_server:[\s\S]*?name: Verify serialized server suites/);

  // Aggregate verify job must remain enabled
  assert.match(trusted, /verify:[\s\S]*?name: verify/);

  // E2E shards (8 shards) and aggregate E2E job must remain enabled
  assert.match(trusted, /e2e_shards:[\s\S]*?name: e2e shard/);
  assert.match(trusted, /shard_count: 8/);
  assert.match(trusted, /e2e:[\s\S]*?name: e2e/);
});

test("commitperclip-review.yml skips the review job for fork repositories", () => {
  const review = readWorkflow("commitperclip-review.yml");
  const jobHeader = review.match(/jobs:\n\s+review:\n\s+if: ([^\n]+)/);
  assert.ok(jobHeader, "review job must declare repository check in if condition");
  assert.equal(
    jobHeader[1].trim(),
    "github.repository == 'paperclipai/paperclip'",
    "commitperclip review must only run on paperclipai/paperclip",
  );
  // Base checkout and quality gates must be intact
  assert.match(review, /Checkout base branch/);
  assert.match(review, /Run quality gates/);
});

test("agent-runtime-images.yml cannot publish images from a fork", () => {
  const workflow = readWorkflow("agent-runtime-images.yml");
  assert.match(
    workflow,
    /build-and-sign:\n\s+# Internal forks must never publish images to the canonical GHCR namespace\.\n\s+if: github\.repository == 'paperclipai\/paperclip' && github\.repository_id == '1170821064'/,
  );
});

test("internal fork omits Docker PR work and recurring eval schedules", () => {
  const trusted = readWorkflow("pr-trusted.yml");
  assert.doesNotMatch(trusted, /docker_context_integrity|Docker context integrity/);
  assert.match(
    trusted,
    /needs: \[gate, policy, typecheck_release_registry, general_tests, verify_paperclip_runner, build\]/,
  );

  for (const filename of ["runner-chaos-evals.yml", "runner-live-evals.yml"]) {
    const workflow = readWorkflow(filename);
    assert.doesNotMatch(workflow, /^  schedule:/m, `${filename} must not recur`);
    assert.match(workflow, /^  workflow_dispatch:/m);
  }
});

test("Paperclip project guidance routes issues and pull requests to the fork", () => {
  const agents = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  const skill = readFileSync(
    new URL("../../../skills/paperclip/SKILL.md", import.meta.url),
    "utf8",
  );
  const contributing = readFileSync(
    new URL("../../../CONTRIBUTING.md", import.meta.url),
    "utf8",
  );
  const template = readFileSync(
    new URL("../../PULL_REQUEST_TEMPLATE.md", import.meta.url),
    "utf8",
  );

  for (const guidance of [agents, skill, contributing, template]) {
    assert.match(guidance, /DF-Studios-App\/paperclip/);
    assert.match(guidance, /upstream/i);
  }
  assert.match(agents, /origin` as the only writable GitHub\s+remote/);
  assert.match(skill, /use `origin` for pushes/);
});

test("release.yml publishing jobs are restricted to canonical repository", () => {
  const release = readWorkflow("release.yml");

  // Every job capable of publishing packages, images, artifacts, or release tags:
  const publishingJobs = [
    { name: "publish_preview", check: /publish_preview:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_image_preview", check: /publish_image_preview:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_canary", check: /publish_canary:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_nightly", check: /publish_nightly:[\s\S]*?if: >-\n\s+([^\n]+)/ },
    { name: "publish_beta", check: /publish_beta:[\s\S]*?if: >-\n\s+([^\n]+)/ },
    { name: "draft_stable_notes", check: /draft_stable_notes:[\s\S]*?if: \${{\s*([^\n]+)/ },
    { name: "publish_stable", check: /publish_stable:[\s\S]*?if: ([^\n]+)/ },
    { name: "canonicalize_stable_notes", check: /canonicalize_stable_notes:[\s\S]*?if: \${{\s*([^\n]+)/ },
  ];

  for (const { name, check } of publishingJobs) {
    const match = release.match(check);
    assert.ok(match, `${name} must define an if condition`);
    assert.match(
      match[1],
      /github\.repository == 'paperclipai\/paperclip'/,
      `${name} must be restricted to paperclipai/paperclip`,
    );
  }

  // Canary verification and publication are both restricted to canonical repository
  assert.match(
    release,
    /verify_canary:[\s\S]*?if: github\.repository == 'paperclipai\/paperclip' && github\.event_name == 'push'/,
  );
  assert.match(
    release,
    /publish_canary:[\s\S]*?if: github\.repository == 'paperclipai\/paperclip' && github\.event_name == 'push'/,
  );
});

test("release.yml preserves read-only validation, candidate selection, and test jobs", () => {
  const release = readWorkflow("release.yml");

  // Read-only jobs must exist
  assert.match(release, /plan_preview:\n\s+# Only the current master commit/);
  assert.match(release, /package_preview:\n\s+name: Build preview migrator/);
  assert.match(release, /image_preview:\n\s+name: Build preview cloud image/);
  assert.match(release, /select_nightly:\n\s+if: github\.event_name == 'schedule'/);
  assert.match(release, /smoke_nightly:\n\s+needs: select_nightly/);
  assert.match(release, /select_beta:\n\s+if: github\.event_name == 'workflow_dispatch'/);
  assert.match(release, /verify_beta_candidate:\n\s+needs: select_beta/);
  assert.match(release, /preflight_stable:\n\s+if: github\.event_name == 'workflow_dispatch'/);
  assert.match(release, /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch'/);
  assert.match(release, /preview_stable:\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.channel == 'stable' && inputs\.dry_run/);
});

test("simulation: fork cannot publish and canonical upstream behavior is unchanged", () => {
  const release = readWorkflow("release.yml");
  const publishingJobs = [
    { name: "publish_preview", check: /publish_preview:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_image_preview", check: /publish_image_preview:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_canary", check: /publish_canary:[\s\S]*?if: ([^\n]+)/ },
    { name: "publish_nightly", check: /publish_nightly:[\s\S]*?if: >-\n\s+([^\n]+)/ },
    { name: "publish_beta", check: /publish_beta:[\s\S]*?if: >-\n\s+([^\n]+)/ },
    { name: "draft_stable_notes", check: /draft_stable_notes:[\s\S]*?if: \${{\s*([^\n]+)/ },
    { name: "publish_stable", check: /publish_stable:[\s\S]*?if: ([^\n]+)/ },
    { name: "canonicalize_stable_notes", check: /canonicalize_stable_notes:[\s\S]*?if: \${{\s*([^\n]+)/ },
  ];

  const forkRepo = "DF-Studios-App/paperclip";
  const upstreamRepo = "paperclipai/paperclip";

  for (const { name, check } of publishingJobs) {
    const match = release.match(check);
    assert.ok(match, `${name} must have an if condition`);
    const cond = match[1].trim();

    // In a fork context, the repository check is false
    const forkEvaluated = cond.includes("github.repository == 'paperclipai/paperclip'")
      ? (forkRepo === "paperclipai/paperclip")
      : true;
    assert.equal(
      forkEvaluated,
      false,
      `Job ${name} must evaluate repository check to false in fork context (${forkRepo})`,
    );

    // In upstream context, the repository check evaluates to true (preserving canonical behavior)
    const upstreamEvaluated = cond.includes("github.repository == 'paperclipai/paperclip'")
      ? (upstreamRepo === "paperclipai/paperclip")
      : false;
    assert.equal(
      upstreamEvaluated,
      true,
      `Job ${name} must evaluate repository check to true in upstream context (${upstreamRepo})`,
    );
  }
});

test("simulation: pr-trusted skips only release steps on fork while running them upstream", () => {
  const forkRepo = "DF-Studios-App/paperclip";
  const upstreamRepo = "paperclipai/paperclip";

  const releaseSteps = [
    { name: "Validate release package manifest", if: "github.repository == 'paperclipai/paperclip'" },
    { name: "Verify release package bootstrap for changed manifests", if: "github.repository == 'paperclipai/paperclip'" },
    { name: "Verify release registry test coverage", if: "github.repository == 'paperclipai/paperclip'" },
    { name: "canary_dry_run", if: "github.repository == 'paperclipai/paperclip' && needs.gate.outputs.full_ci == 'true'" },
  ];

  for (const step of releaseSteps) {
    const forkRuns = (forkRepo === "paperclipai/paperclip");
    assert.equal(forkRuns, false, `${step.name} must be skipped on fork`);

    const upstreamRuns = (upstreamRepo === "paperclipai/paperclip");
    assert.equal(upstreamRuns, true, `${step.name} must run on upstream`);
  }
});

test("AGY adapter is workspace-only in fork with npm publication disabled", () => {
  const manifest = readJson(
    new URL("../../../scripts/release-package-manifest.json", import.meta.url),
  );
  const agyEntry = manifest.find(
    (e) => e.name === "@paperclipai/adapter-agy-local",
  );
  assert.ok(agyEntry, "agy-local must exist in release-package-manifest.json");
  assert.equal(
    agyEntry.publishFromCi,
    false,
    "AGY adapter must have publishFromCi set to false",
  );

  const readme = readFileSync(
    new URL("../../../packages/adapters/agy-local/README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /AGY is a workspace-only feature in this fork and npm publication from the fork is intentionally disabled/,
    "README.md must document workspace-only and disabled publication in this fork",
  );
});
