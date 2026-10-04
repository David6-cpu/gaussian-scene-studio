import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
export function parseSwap(text) {
  const m = /used\s*=\s*([0-9.]+)([KMGT])/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n)
    ? n * { K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[m[2]]
    : null;
}
export function pressureLabel(raw) {
  return { 1: "normal", 2: "warning", 4: "critical" }[raw.trim()] ?? null;
}
async function read(file, args) {
  try {
    return {
      raw: (await exec(file, args, { timeout: 3000 })).stdout.trim(),
      error: null,
    };
  } catch (e) {
    return { raw: "", error: e.message };
  }
}
export async function sampleMemory(pids = []) {
  if (pids.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error("Invalid PID");
  const [pressure, swap, rss] = await Promise.all([
    read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    read("/usr/sbin/sysctl", ["vm.swapusage"]),
    pids.length
      ? read("/bin/ps", ["-p", pids.join(","), "-o", "pid=,rss="])
      : Promise.resolve({ raw: "", error: "No owned browser PIDs supplied" }),
  ]);
  const processes = rss.raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, kib] = line.trim().split(/\s+/).map(Number);
      return { pid, rssKiB: kib, physFootprintBytes: null };
    });
  return {
    timestamp: new Date().toISOString(),
    pressure: pressureLabel(pressure.raw),
    pressureRaw: pressure,
    swapUsedMiB: parseSwap(swap.raw),
    swapRaw: swap,
    processes,
    rssError: rss.error,
    gpuBytes: null,
    notes:
      "RSS is per process, never summed. Exact GPU memory and phys_footprint not collected.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2),
    arg = (key, def) =>
      args.includes(key) ? args[args.indexOf(key) + 1] : def;
  const seconds = Number(arg("--seconds", "60")),
    output = arg("--output", ".local/memory.json"),
    pids = arg("--pids", "") ? arg("--pids", "").split(",").map(Number) : [];
  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > 180 ||
    pids.some((n) => !Number.isInteger(n) || n < 1) ||
    !output
  )
    throw new Error("Invalid observation arguments");
  await mkdir(dirname(output), { recursive: true });
  const samples = [],
    start = Date.now();
  for (let n = 0; n <= seconds; n++) {
    if (n)
      await new Promise((r) =>
        setTimeout(r, Math.max(0, start + n * 1000 - Date.now())),
      );
    samples.push(await sampleMemory(pids));
    const tmp = output + ".tmp";
    await writeFile(
      tmp,
      JSON.stringify(
        { completed: n === seconds, intervalMs: 1000, samples },
        null,
        2,
      ),
    );
    await rename(tmp, output);
  }
  console.log(`Saved ${samples.length} memory samples to ${output}`);
}
