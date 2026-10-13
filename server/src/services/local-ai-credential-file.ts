import fs from "node:fs/promises";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Bounded descriptor read; never follows symlinks or reopens a checked path. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  if (process.platform === "win32") return readWindowsLocalAiCredentialFile(filename);
  const file = await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Windows has no POSIX uid or 0600 modes and no O_NOFOLLOW, so the checks are
 * done with lstat instead: every ancestor and the file itself must be a real
 * directory or regular file (no symlinks or junctions), and the opened handle
 * must still match the inode that was checked before it is read.
 */
async function readWindowsLocalAiCredentialFile(filename: string): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error("Credential file must have an absolute path");
  const resolved = path.resolve(filename);
  const { root } = path.parse(resolved);
  let current = resolved;
  while (true) {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new Error("Invalid credential file");
    if (current === resolved ? !info.isFile() : !info.isDirectory()) throw new Error("Invalid credential file");
    if (current === root || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  const before = await fs.lstat(resolved);
  if (before.size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
  const handle = await fs.open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await handle.close();
  }
}
