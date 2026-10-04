import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MODEL = Object.freeze({
  alias: "qwen2.5-3b-instruct-q4_k_m",
  repository: "Qwen/Qwen2.5-3B-Instruct-GGUF",
  revision: "7dabda4d13d513e3e842b20f0d435c732f172cbe",
  relativeFile:
    ".local/models/qwen2.5-3b-instruct-q4_k_m/7dabda4d13d513e3e842b20f0d435c732f172cbe/qwen2.5-3b-instruct-q4_k_m.gguf",
  bytes: 2104932768,
  sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
});
export const RUNTIME = "/opt/homebrew/Cellar/llama.cpp/10470/bin/llama-server";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyModel(root, config = MODEL) {
  const path = join(root, config.relativeFile);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw Error(`模型文件缺失：${path}。请恢复已核验的3B文件；不会自动下载。`);
  }
  if (!info.isFile() || info.size !== config.bytes)
    throw Error("模型文件大小不符，请恢复完整文件。不会加载或修改该文件。");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (sha256 !== config.sha256)
    throw Error(
      "模型文件SHA-256不符，请恢复已核验文件。不会加载或修改该文件。",
    );
  return {
    path,
    sha256,
    bytes: info.size,
    repository: config.repository,
    revision: config.revision,
  };
}
export function resourceProblem(sample) {
  if (!Number.isFinite(sample.pressure) || !Number.isFinite(sample.freeFileGiB))
    return "无法读取内存状态，请稍后重试。";
  if (sample.pressure !== 1)
    return "当前内存压力偏高，已取消启动。请自行退出暂不用的大型应用后重试。";
  if (sample.freeFileGiB < 3.75)
    return `估计内存余量${sample.freeFileGiB.toFixed(2)}GiB，低于3B启动门槛3.75GiB。请自行退出暂不用的大型应用后重试。`;
  return null;
}
export async function sampleResources(pid) {
  const [s, v] = await Promise.all([
    exec(
      "/usr/sbin/sysctl",
      ["kern.memorystatus_vm_pressure_level", "vm.swapusage"],
      { timeout: 3000 },
    ),
    exec("/usr/bin/vm_stat", [], { timeout: 3000 }),
  ]);
  const page = Number(/page size of (\d+)/.exec(v.stdout)?.[1]);
  const pages = Object.fromEntries(
    [...v.stdout.matchAll(/^([^:]+):\s+(\d+)\./gm)].map((m) => [
      m[1],
      Number(m[2]),
    ]),
  );
  const sample = {
    at: new Date().toISOString(),
    pressure: Number(/vm_pressure_level: (\d+)/.exec(s.stdout)?.[1]),
    swapMiB: Number(/used = ([0-9.]+)M/.exec(s.stdout)?.[1]),
    freeFileGiB:
      ((pages["Pages free"] + pages["File-backed pages"]) * page) / 1024 ** 3,
  };
  if (!Number.isFinite(sample.swapMiB)) throw Error("无法读取交换内存状态。");
  if (pid) {
    const r = await exec("/bin/ps", ["-p", String(pid), "-o", "rss="], {
      timeout: 3000,
    });
    sample.modelRssMiB = Number(r.stdout.trim()) / 1024;
  }
  return sample;
}
export async function assertPortsFree(ports) {
  for (const port of ports) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", (error) =>
        reject(
          Error(
            `端口${port}已被占用或无法监听（${error.code}）。请正常停止对应服务后重试；不会终止其他进程。`,
          ),
        ),
      );
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        server.close(resolve),
      );
    });
  }
}
async function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return (
      (
        await exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          timeout: 3000,
          env: { ...process.env, LC_ALL: "C" },
        })
      ).stdout.trim() || null
    );
  } catch (e) {
    if (e.code === 1) return null;
    throw e;
  }
}
async function readSession(dir) {
  try {
    const session = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    if (
      !/^[0-9a-f-]{36}$/.test(session.id) ||
      !Number.isSafeInteger(session.pid) ||
      typeof session.processStart !== "string"
    )
      throw Error();
    return session;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw Error(
      "启动记录不完整。请先关闭本项目启动终端，确认服务已停，再移走.local/launcher/session.json后重试。",
    );
  }
}
export async function claimSession(dir) {
  await mkdir(dir, { recursive: true });
  const previous = await readSession(dir);
  if (previous) {
    if ((await processStart(previous.pid)) === previous.processStart)
      throw Error(
        "本项目已在运行。请使用已打开的窗口或 http://127.0.0.1:4173/_local/ ，无需重复启动。",
      );
    throw Error(
      "上次启动终端异常退出。请先确认4173与8080服务已停，再移走.local/launcher/session.json后重试；不会自动接管遗留进程。",
    );
  }
  const session = {
    id: randomUUID(),
    pid: process.pid,
    processStart: await processStart(process.pid),
    startedAt: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(join(dir, "session.json"), "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error("本项目已在运行或正在启动，请使用已有窗口。");
    throw e;
  }
  try {
    await handle.writeFile(JSON.stringify(session));
  } finally {
    await handle.close();
  }
  return session;
}
export async function requestStop(dir) {
  const session = await readSession(dir);
  if (!session) return false;
  if ((await processStart(session.pid)) !== session.processStart)
    throw Error("原启动终端已退出，无法确认服务归属。不会按旧PID停止进程。");
  // Only a live supervisor observes this marker; never signal a PID read from disk.
  await writeFile(join(dir, `stop-${session.id}`), session.id, { mode: 0o600 });
  return true;
}
export async function releaseSession(dir, session) {
  const current = await readSession(dir);
  if (current?.id !== session.id) return;
  await unlink(join(dir, "session.json"));
  await unlink(join(dir, `stop-${session.id}`)).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}
export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return { forced: false };
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), 10000);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    child.kill("SIGKILL"); // only our still-live ChildProcess, never a saved PID or port owner
    await exited;
  }
  return { forced: timedOut };
}
