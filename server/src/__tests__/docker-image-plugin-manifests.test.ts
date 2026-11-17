import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the production image (Dockerfile `build` stage).
 *
 * The plugin loader reads each installed plugin's manifest from its package
 * root on startup. A plugin that declares `paperclipPlugin.manifest` but whose
 * manifest is never compiled fails to activate and is left in the `error`
 * state. The production stage copies `/app` from the `build` stage, so the
 * build stage must compile every plugin the image ships.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

const shippedPlugins = [
  { name: "@paperclipai/plugin-llm-wiki", dir: "plugin-llm-wiki" },
];

function buildStage(source: string): string {
  const start = source.indexOf("\nFROM base AS build\n");
  expect(start, "Dockerfile must define the `build` stage").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nFROM ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("docker image plugin manifests", () => {
  const stage = buildStage(dockerfile);

  it.each(shippedPlugins)("the build stage compiles $name so its manifest exists in the image", ({ name, dir }) => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "plugins", dir, "package.json"), "utf8"),
    ) as { name: string; paperclipPlugin?: { manifest?: string } };
    expect(packageJson.name).toBe(name);
    expect(packageJson.paperclipPlugin?.manifest, `${name} must declare paperclipPlugin.manifest`).toBeTruthy();

    expect(
      stage,
      `the build stage must run \`pnpm --filter ${name} build\` so ${packageJson.paperclipPlugin?.manifest} exists in the image`,
    ).toContain(`pnpm --filter ${name} build`);
  });
});
