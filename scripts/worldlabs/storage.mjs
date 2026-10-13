import { open, mkdir, lstat, rename, unlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export async function directory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink())
    throw Error("invalid-trial-directory");
}
export async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function readBytes(file, limit = 1024 ** 2) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error("invalid-local-file");
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw Error("invalid-local-file");
    return bytes;
  } finally {
    await handle.close();
  }
}
export const readJson = async (file) => JSON.parse(await readBytes(file));
async function syncDirectory(dir) {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function exclusive(dir, name, bytes) {
  const handle = await open(join(dir, name), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dir);
}
export async function atomic(dir, name, bytes) {
  const temp = `.${name}.${randomUUID()}.tmp`;
  try {
    await exclusive(dir, temp, bytes);
    await rename(join(dir, temp), join(dir, name));
    await syncDirectory(dir);
  } finally {
    await unlink(join(dir, temp)).catch(() => {});
  }
}
export const saveJson = (dir, name, value) =>
  atomic(dir, name, JSON.stringify(value, null, 2) + "\n");
export async function locked(dir, fn) {
  const lock = join(dir, ".operation-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw Error(
        "trial-locked: verify no running process before manual recovery",
      );
    throw error;
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock);
  }
}
