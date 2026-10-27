import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(packageRoot, "src", "cliplab");
const destinationDirectory = path.join(packageRoot, "dist", "cliplab");

mkdirSync(destinationDirectory, { recursive: true });
for (const fileName of ["LICENSE", "PROVENANCE.md"]) {
  copyFileSync(path.join(sourceDirectory, fileName), path.join(destinationDirectory, fileName));
}
