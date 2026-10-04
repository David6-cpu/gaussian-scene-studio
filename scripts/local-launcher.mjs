import { access, mkdir, open, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  MODEL,
  RUNTIME,
  verifyModel,
  sampleResources,
  resourceProblem,
  assertPortsFree,
  claimSession,
  requestStop,
  releaseSession,
  stopChild,
  pause,
} from "./launcher-core.mjs";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(root, ".local/launcher");
const statusUrl = "http://127.0.0.1:4173/_local/";
const sceneUrl = "http://127.0.0.1:4173/?planner=3b";
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function stop() {
  if (!(await requestStop(local))) {
    console.log("没有本入口管理的运行实例，无需停止。不会触碰其他服务。");
    return;
  }
  console.log("已向本项目启动终端发出停止请求，等待释放模型和网页…");
  for (let i = 0; i < 60; i++) {
    if (!(await exists(join(local, "session.json")))) {
      console.log("已停止本入口管理的服务。");
      return;
    }
    await pause(500);
  }
  throw Error(
    "停止尚未完成，请查看启动终端与.local/launcher/runs中的日志；不会按端口或旧PID强制终止进程。",
  );
}
async function start() {
  const owner = await claimSession(local);
  const run = join(local, "runs", owner.id);
  let web,
    child,
    stopWatch,
    stoppedBy = "",
    failure,
    base;
  const state = {
    phase: "checking",
    message: "正在核验本地文件…",
    model: MODEL.alias,
    verified: false,
  };
  const publish = () => {
    if (web?.connected)
      web.send({ state }, (error) => {
        if (error) stoppedBy ||= "网页状态连接已断开";
      });
  };
  const update = (phase, message) => {
    Object.assign(state, { phase, message });
    console.log(message);
    publish();
  };
  const signalStop = (signal) => {
    stoppedBy ||= `启动终端收到${signal}`;
  };
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => {
    const fn = () => signalStop(sig);
    process.on(sig, fn);
    return [sig, fn];
  });
  const checkStop = () => {
    if (stoppedBy) throw Error(stoppedBy);
  };
  const browser = async (url) => {
    try {
      await exec("/usr/bin/open", [url], { timeout: 5000 });
    } catch {
      console.log(`浏览器未自动打开，请点击：${url}`);
    }
  };
  try {
    await mkdir(run, { recursive: true });
    stopWatch = setInterval(async () => {
      if (await exists(join(local, `stop-${owner.id}`)))
        stoppedBy ||= "双击停止入口";
    }, 250);
    await assertPortsFree([4173, 8080]);
    if (!(await exists(RUNTIME)))
      throw Error(
        "已验证的llama.cpp运行器缺失。请恢复原安装路径；本入口不会安装软件。",
      );
    if (!(await exists(join(root, "node_modules/vite/package.json"))))
      throw Error("项目现有依赖缺失，请恢复项目依赖。不会自动安装。");
    if (
      Object.keys(process.env).some(
        (k) => k.startsWith("LLAMA_") || k === "XDG_CONFIG_HOME",
      ) ||
      (await exists("/etc/llama.cpp/config.ini")) ||
      (await exists(join(homedir(), ".config/llama.cpp/config.ini")))
    )
      throw Error(
        "检测到额外llama.cpp配置或环境变量，可能覆盖本机设置。请先核对启动环境；不会读取或改写配置内容。",
      );
    update("checking", "正在校验官方3B权重（约2.10GB，SHA-256）…");
    state.verified = await verifyModel(root);
    await writeFile(
      join(run, "model-verification.json"),
      JSON.stringify(state.verified, null, 2),
    );
    checkStop();
    update("preparing", "权重校验通过。正在准备本机网页…");
    const webLog = await open(join(run, "web.log"), "w");
    let webReady = false,
      webError;
    try {
      web = spawn(process.execPath, [join(root, "scripts/launcher-web.mjs")], {
        cwd: root,
        stdio: ["ignore", webLog.fd, webLog.fd, "ipc"],
      });
      web.on("error", (error) => {
        webError = error;
      });
      web.on("message", (message) => {
        if (message?.ready) webReady = true;
        if (message?.stop) stoppedBy ||= "状态页停止按钮";
      });
    } finally {
      await webLog.close();
    }
    const checkWeb = () => {
      if (webError) throw webError;
      if (web.exitCode !== null || web.signalCode !== null || !web.connected)
        throw Error("本次网页服务已退出，请查看web.log。正在停止本次模型。");
    };
    const webBegan = Date.now();
    while (!webReady) {
      checkStop();
      checkWeb();
      if (Date.now() - webBegan > 60000)
        throw Error("网页准备超过60秒，取消启动；请查看web.log。");
      await pause(100);
    }
    base = await sampleResources();
    await writeFile(
      join(run, "resources-before.json"),
      JSON.stringify(base, null, 2),
    );
    const problem = resourceProblem(base);
    if (problem) throw Error(problem);
    state.resources = base;
    checkStop();
    update(
      "loading",
      "正在加载3B；启动终端请保持打开。状态页可随时停止本次服务。",
    );
    await browser(statusUrl);
    checkStop();
    const args = [
      "--model",
      state.verified.path,
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "--alias",
      MODEL.alias,
      "--ctx-size",
      "4096",
      "--parallel",
      "1",
      "--predict",
      "1024",
      "--batch-size",
      "128",
      "--ubatch-size",
      "128",
      "--threads",
      "4",
      "--cache-ram",
      "0",
      "--offline",
      "--no-webui",
      "--no-agent",
    ];
    await writeFile(
      join(run, "launch.json"),
      JSON.stringify(
        {
          runtime: RUNTIME,
          args,
          owner,
          webPid: web.pid,
          resourceGateGiB: 3.75,
        },
        null,
        2,
      ),
    );
    let spawnError;
    const modelLog = await open(join(run, "llama-server.log"), "w");
    try {
      child = spawn(RUNTIME, args, {
        cwd: root,
        stdio: ["ignore", modelLog.fd, modelLog.fd],
      });
      child.on("error", (e) => {
        spawnError = e;
      });
    } finally {
      await modelLog.close();
    }
    await writeFile(join(run, "model.pid"), String(child.pid));
    const began = Date.now();
    let ready = false,
      lastSample = 0;
    while (!stoppedBy) {
      checkWeb();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(
          "模型服务已退出，请查看本次llama-server.log；不会改用离线示例冒充推理。",
        );
      if (Date.now() - lastSample >= 5000) {
        const sample = await sampleResources(child.pid);
        state.resources = sample;
        await appendFile(
          join(run, "resources.jsonl"),
          JSON.stringify(sample) + "\n",
        );
        publish();
        lastSample = Date.now();
        if (
          sample.pressure !== 1 ||
          sample.swapMiB - base.swapMiB > 256 ||
          sample.modelRssMiB > 4096
        )
          throw Error(
            "运行期间内存压力或用量超过保护门槛，正在停止本项目。请稍后重试。",
          );
      }
      if (!ready) {
        let health;
        try {
          const r = await fetch("http://127.0.0.1:8080/health", {
            signal: AbortSignal.timeout(500),
            redirect: "error",
          });
          if (r.ok) health = await r.json();
        } catch {}
        if (health?.status === "ok") {
          const listening = (
            await exec(
              "/usr/sbin/lsof",
              [
                "-nP",
                "-a",
                "-p",
                String(child.pid),
                "-iTCP:8080",
                "-sTCP:LISTEN",
                "-Fn",
              ],
              { timeout: 3000 },
            )
          ).stdout;
          if (!listening.includes("n127.0.0.1:8080"))
            throw Error("未确认本次模型进程监听本机8080，取消启动。");
          ready = true;
          await writeFile(
            join(run, "ready.json"),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                modelReadyMs: Date.now() - began,
                modelPid: child.pid,
                listening,
              },
              null,
              2,
            ),
          );
          update(
            "ready",
            "已就绪：本地3B和网页已启动。输入描述、审阅参数，再确认生成。用完请双击停止入口。",
          );
          console.log(`场景：${sceneUrl}\n状态与停止：${statusUrl}`);
          await browser(sceneUrl);
        } else if (Date.now() - began > 90000)
          throw Error("3B加载超过90秒，已取消本次启动；请查看日志并稍后重试。");
      }
      await pause(250);
    }
  } catch (error) {
    if (!stoppedBy) {
      failure = error.message;
      process.exitCode = 1;
      update("error", `启动或运行未完成：${failure}`);
    }
  } finally {
    clearInterval(stopWatch);
    update("stopping", "正在停止本次模型与网页…");
    const childResult = await stopChild(child);
    const webResult = await stopChild(web);
    const result = {
      at: new Date().toISOString(),
      reason: failure || stoppedBy || "finished",
      failed: !!failure,
      child: child
        ? {
            pid: child.pid,
            exitCode: child.exitCode,
            signal: child.signalCode,
            ...childResult,
          }
        : null,
      web: web
        ? {
            pid: web.pid,
            exitCode: web.exitCode,
            signal: web.signalCode,
            ...webResult,
          }
        : null,
    };
    try {
      await writeFile(
        join(run, "result.json"),
        JSON.stringify(result, null, 2),
      );
    } catch (error) {
      console.error(`服务已结束，但保存退出日志失败：${error.message}`);
      process.exitCode = 1;
    } finally {
      await releaseSession(local, owner);
    }
    listeners.forEach(([sig, fn]) => process.off(sig, fn));
    update(
      "stopped",
      `已停止本入口管理的服务${childResult.forced ? "（模型未及时响应，已结束本次子进程）" : ""}。日志：${run}`,
    );
  }
}
try {
  if (process.argv[2] === "start") await start();
  else if (process.argv[2] === "stop") await stop();
  else throw Error("请双击“启动湿地项目.command”或“停止湿地项目.command”。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
