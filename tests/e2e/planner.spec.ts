import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  demoPlan,
  planScene,
  MODEL,
  LLAMA_MODEL,
  LLAMA_SMALL_MODEL,
} from "../../src/planner/service";
import { confirmPlan, HISTORY_KEY } from "../../src/planner/history";

test.beforeEach(async ({ page }) => {
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
test('double-click entry selects 3B without applying a plan or changing stored history', async ({ page }) => {
  const history = await page.evaluate(() => localStorage.getItem('wetland.plans.v1'));
  await page.goto('/?planner=3b&advanced');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#plan-backend')).toHaveValue('llama.cpp');
  await expect(page.locator('#plan-model')).toHaveValue(LLAMA_SMALL_MODEL);
  await expect(page.locator('#plan-confirm')).toBeDisabled();
  await expect(page.locator('#plan-source')).toHaveText('没有待审规划');
  expect(await page.evaluate(() => localStorage.getItem('wetland.plans.v1'))).toBe(history);
  await expect(page.locator('#algorithmVersion')).toHaveValue('f0-riverside-grass-v2');
  await page.locator('#plan-model').selectOption(LLAMA_MODEL);
  await expect(page.locator('#plan-model')).toHaveValue(LLAMA_MODEL);
});
test("explicit llama.cpp fixture remains reviewable and preserves backend in confirmed file", async ({
  page,
}) => {
  await expect(page.locator("#plan-backend")).toHaveValue("ollama");
  await page.locator("#plan-backend").selectOption("llama.cpp");
  await page.locator("#plan-model").selectOption(LLAMA_MODEL);
  const draft = await planScene(
    "6米湿地",
    async () => ({
      raw: JSON.stringify(demoPlan().proposal),
      model: LLAMA_MODEL,
      done: true,
      doneReason: "stop",
    }),
    new AbortController().signal,
    "llama.cpp",
  );
  await page.route("**/api/planner/generate", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      prompt: "6米湿地",
      backend: "llama.cpp",
      model: LLAMA_MODEL,
    });
    return route.fulfill({ json: draft });
  });
  await page.locator("#plan-prompt").fill("6米湿地");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-source")).toContainText("llama.cpp");
  await expect(page.locator("#plan-source")).toContainText("权重未核验");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
  await expect(page.locator("#plan-current")).toContainText("llama.cpp");
  await expect(page.locator("#plan-message")).toContainText("场景已显示");
  const event = page.waitForEvent("download");
  await page.locator("#plan-save").click();
  const path = (await (await event).path())!;
  const record = JSON.parse(await readFile(path, "utf8"));
  expect(record.schemaVersion).toBe(3);
  expect(record.draft).toMatchObject({
    source: "llama.cpp",
    backend: "llama.cpp",
  });
  await page.locator("#plan-file").setInputFiles(path);
  await expect(page.locator("#plan-source")).toContainText("历史导入");
  await page.locator("#plan-backend").selectOption("ollama");
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await expect(page.locator("#plan-current")).toContainText("llama.cpp");
});
test("changing backend discards old inference and status responses", async ({
  page,
}) => {
  // Resolve after the caller's JSON continuation had an event-loop turn to run.
  // Network completion alone does not prove the old UI callback has executed.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    Object.assign(window, {
      oldPlannerStatusHandled: new Promise<void>((resolve) => {
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (String(args[0]).endsWith("/api/planner/status?backend=ollama&model=qwen2.5:7b-instruct-q4_K_M")) {
            const read = response.json.bind(response);
            response.json = async () => {
              const body = await read();
              setTimeout(resolve, 0);
              return body;
            };
          }
          return response;
        };
      }),
    });
  });
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/api/planner/generate", async (route) => {
    await hold;
    await route.fulfill({ json: demoPlan() }).catch(() => {});
  });
  await page.route("**/api/planner/status?backend=ollama&model=qwen2.5:7b-instruct-q4_K_M", async (route) => {
    await hold;
    await route
      .fulfill({ json: { model: MODEL, reason: "STALE_STATUS" } })
      .catch(() => {});
  });
  await page.locator("#plan-check").click();
  await page.locator("#plan-prompt").fill("湿地");
  await page.locator("#plan-run").click();
  await page.locator("#plan-backend").selectOption("llama.cpp");
  release();
  await page.evaluate(
    () =>
      (window as unknown as { oldPlannerStatusHandled: Promise<void> })
        .oldPlannerStatusHandled,
  );
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await expect(page.locator("#plan-source")).toContainText("没有待审规划");
  await expect(page.locator("#plan-runtime")).not.toContainText("STALE_STATUS");
  await page.route("**/api/planner/status?backend=llama.cpp&model=qwen2.5-3b-instruct-q4_k_m", (route) =>
    route.fulfill({
      json: { model: LLAMA_SMALL_MODEL, reason: "别名可用；权重未核验" },
    }),
  );
  await page.locator("#plan-check").click();
  await expect(page.locator("#plan-runtime")).toContainText(LLAMA_SMALL_MODEL);
});
test("offline draft requires confirmation; edits, history and file roundtrip preserve provenance", async ({
  page,
}) => {
  await page.locator("#plan-demo").click();
  await expect(page.locator("#plan-source")).toContainText("离线示例");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
  const editor = page.locator("#plan-proposal");
  const proposal = JSON.parse(await editor.inputValue());
  proposal.seed = 321;
  await editor.fill(JSON.stringify(proposal, null, 2));
  await page.locator("#plan-preview").click();
  await expect(page.locator("#plan-summary")).toContainText(
    "engineering-placement-v1",
  );
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "321");
  await expect(page.locator("#plan-current")).toContainText("人工修改");
  const event = page.waitForEvent("download");
  await page.locator("#plan-save").click();
  const download = await event;
  const path = (await download.path())!;
  const record = JSON.parse(await readFile(path, "utf8"));
  expect(record.recipe.seed).toBe(321);
  expect(record.draft.source).toBe("demo");
  expect(record.kind).toBe("manual");
  await page.locator("#clear").click();
  await expect(page.locator("#plan-current")).toContainText("无已关联规划");
  await page.locator("#plan-file").setInputFiles(path);
  await expect(page.locator("#plan-source")).toContainText("历史导入");
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#plan-current")).toContainText("历史导入");
  await page.locator("#seed").fill("322");
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "322");
  await expect(page.locator("#plan-current")).toContainText("人工修改");
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#plan-history option")).toHaveCount(3);
});

test("unreadable history is preserved while a confirmed backup remains downloadable", async ({
  page,
}) => {
  const valid = await confirmPlan(demoPlan());
  const damaged = { ...valid, recipeHash: "0".repeat(64) };
  const original = JSON.stringify([valid, damaged]);
  await page.evaluate(
    ({ key, original }) => localStorage.setItem(key, original),
    { key: HISTORY_KEY, original },
  );
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#plan-storage")).toContainText("历史记录未载入");
  await page.locator("#plan-demo").click();
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), HISTORY_KEY),
  ).toBe(original);
  await expect(page.locator("#plan-storage")).toContainText("保留");
  const event = page.waitForEvent("download");
  await page.locator("#plan-save").click();
  const path = (await (await event).path())!;
  const downloaded = JSON.parse(await readFile(path, "utf8"));
  expect(downloaded.recipe.seed).toBe(42);
  expect(downloaded.draft.source).toBe("demo");
  await page.locator("#plan-file").setInputFiles(path);
  await expect(page.locator("#plan-source")).toContainText("历史导入");
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#plan-current")).toContainText("历史导入");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), HISTORY_KEY),
  ).toBe(original);
});
test("actual local API reports default fallback when the selected model service is unavailable", async ({
  page,
}) => {
  // This host's real local runtime probe established no service. No intercepted model success.
  await page.locator("#plan-prompt").fill("一小片湿地，放四块石头");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-source")).toContainText("默认回退");
  await expect(page.locator("#plan-message")).toContainText("未解释输入");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
});
test("late reply cannot repopulate a cleared workbench", async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/api/planner/generate", async (route) => {
    await hold;
    await route.fulfill({ json: demoPlan() }).catch(() => {});
  });
  await page.locator("#plan-prompt").fill("湿地");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-message")).toContainText("规划中");
  await page.locator("#clear").click();
  release();
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await expect(page.locator("#plan-source")).toContainText("没有待审规划");
});
test("manual edits invalidate pending responses and later requests win", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let calls = 0;
  await page.route("**/api/planner/generate", async (route) => {
    calls++;
    if (calls === 1) await hold;
    await route.fulfill({ json: demoPlan() }).catch(() => {});
  });
  await page.locator("#plan-prompt").fill("湿地");
  await page.locator("#plan-run").click();
  await page.locator("#seed").fill("99");
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-source")).toContainText("离线示例");
  release();
  await expect(page.locator("#seed")).toHaveValue("99");
});
test("old scene ZIP clears planning attribution; hostile text remains plain", async ({
  page,
}) => {
  await page.locator("#plan-demo").click();
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
  const event = page.waitForEvent("download");
  await page.locator("#save").click();
  const path = (await (await event).path())!;
  await page.locator("#bundle-file").setInputFiles(path);
  await expect(page.locator("#status")).toContainText("已导入");
  await expect(page.locator("#plan-current")).toContainText("无已关联规划");
  await page.route("**/api/planner/generate", (route) =>
    route.fulfill({
      status: 400,
      json: { error: '<img src=x onerror="window.evil=1">' },
    }),
  );
  await page.locator("#plan-prompt").fill("湿地");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-message")).toContainText("<img");
  await expect(page.locator("#planner img")).toHaveCount(0);
});

for (const previousScene of [false, true]) {
  test(`confirmed record stays downloadable after quota and build failure; previous=${previousScene}`, async ({
    page,
  }) => {
    let previousId: string | null = null;
    if (previousScene) {
      await page.locator("#plan-demo").click();
      await page.locator("#plan-confirm").click();
      await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
      previousId = await page
        .locator("#plan-evidence")
        .evaluate((node) => JSON.parse(node.textContent!).current.id);
    }
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      window.Worker = function () {
        throw new Error("injected build unavailable");
      } as unknown as typeof Worker;
    });
    await page.locator("#plan-demo").click();
    const proposal = JSON.parse(
      await page.locator("#plan-proposal").inputValue(),
    );
    proposal.seed = 98;
    await page.locator("#plan-proposal").fill(JSON.stringify(proposal));
    await page.locator("#plan-preview").click();
    await page.locator("#plan-confirm").click();
    await expect(page.locator("#plan-storage")).toContainText("保存失败");
    await expect(page.locator("#plan-message")).toContainText("场景未能启动");
    await expect(page.locator("#plan-save")).toBeEnabled();
    const event = page.waitForEvent("download");
    await page.locator("#plan-save").click();
    const path = (await (await event).path())!;
    const downloaded = JSON.parse(await readFile(path, "utf8"));
    expect(downloaded.recipe.seed).toBe(98);
    expect(downloaded.id).not.toBe(previousId);
    const evidence = JSON.parse(
      (await page.locator("#plan-evidence").textContent()) ?? "{}",
    );
    expect(evidence.current?.id ?? null).toBe(previousId);
    expect(evidence.latestConfirmed.id).toBe(downloaded.id);
    expect(evidence.latestConfirmed.recipeHash).toBe(downloaded.recipeHash);
  });
}

test("asynchronous failed build reports retained downloadable confirmation", async ({
  page,
}) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.postMessage = (data: { requestId: number }) => {
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    requestId: data.requestId,
                    ok: false,
                    error: "injected worker failure",
                  },
                }),
              ),
            0,
          );
        };
      }
    };
  });
  await page.locator("#plan-demo").click();
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#plan-message")).toContainText("场景生成未成功");
  await expect(page.locator("#plan-save")).toBeEnabled();
  await expect(page.locator("#plan-current")).toContainText("无已关联规划");
});

test("an invalid newer manual generation cancels an older build", async ({
  page,
}) => {
  await page.evaluate(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event) => {
          event.stopImmediatePropagation();
          Object.assign(window, {
            releasePlannerBuild: () =>
              this.onmessage?.call(
                this,
                new MessageEvent("message", { data: event.data }),
              ),
          });
        });
      }
    };
  });
  await page.locator("#seed").fill("999");
  await page.locator("#generate").click();
  await page.waitForFunction(() =>
    Object.hasOwn(window, "releasePlannerBuild"),
  );
  await page.locator("#seed").fill("-1");
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await page.evaluate(async () => {
    await (
      window as unknown as { releasePlannerBuild: () => Promise<void> }
    ).releasePlannerBuild();
  });
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-seed",
    "20261002",
  );
});

for (const budget of ["count", "bytes"] as const) {
  test(`history eviction visibly explains the ${budget} limit and retains newest version`, async ({
    page,
  }) => {
    const draft =
      budget === "count"
        ? demoPlan()
        : await planScene(
            "湿地",
            async () => ({
              raw: "x".repeat(65000),
              model: MODEL,
              done: true,
              doneReason: "stop",
            }),
            new AbortController().signal,
          );
    const records = [];
    for (let i = 0; i < (budget === "count" ? 20 : 7); i++)
      records.push(await confirmPlan(draft));
    const oldIds = records.map((r) => r.id);
    await page.evaluate(
      ({ key, records }) => localStorage.setItem(key, JSON.stringify(records)),
      { key: HISTORY_KEY, records },
    );
    await page.reload();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expect(page.locator("#plan-history option")).toHaveCount(
      records.length,
    );
    if (budget === "count") await page.locator("#plan-demo").click();
    else {
      await page.route("**/api/planner/generate", (route) =>
        route.fulfill({ json: draft }),
      );
      await page.locator("#plan-prompt").fill("湿地");
      await page.locator("#plan-run").click();
      await expect(page.locator("#plan-source")).toContainText("默认回退");
    }
    await page.locator("#plan-confirm").click();
    await expect(page.locator("#plan-storage")).toContainText("移出 1 条");
    await expect(page.locator("#plan-storage")).toContainText(
      budget === "count" ? "20条" : "1MiB",
    );
    const stored = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      HISTORY_KEY,
    );
    expect(stored).toHaveLength(records.length);
    expect(oldIds).not.toContain(stored[0].id);
    expect(stored.slice(1).map((r: { id: string }) => r.id)).toEqual(
      oldIds.slice(0, -1),
    );
  });
}

// This is a controlled UI contract test; real 3B inference is recorded separately.
test("selecting 3B records its identity and changing model invalidates review", async ({ page }) => {
  const small = "qwen2.5-3b-instruct-q4_k_m";
  await page.locator("#plan-backend").selectOption("llama.cpp");
  await expect(page.locator("#plan-model")).toHaveValue(small);
  const draft = await planScene("两块石头", async () => ({raw: JSON.stringify(demoPlan().proposal), model: small, done: true, doneReason: "stop"}), new AbortController().signal, "llama.cpp", small);
  await page.route("**/api/planner/generate", route => {
    expect(route.request().postDataJSON()).toEqual({prompt: "两块石头", backend: "llama.cpp", model: small});
    return route.fulfill({json: draft});
  });
  await page.locator("#plan-prompt").fill("两块石头");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-source")).toContainText(small);
  await expect(page.locator("#plan-confirm")).toBeEnabled();
  await page.locator("#plan-model").selectOption(LLAMA_MODEL);
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  await expect(page.locator("#plan-source")).toContainText("没有待审规划");
});

test("conflicting terrain layers ask for clarification without changing scene or history", async ({ page }) => {
  const before = await page.locator("#scene-evidence").textContent();
  await page.locator("#plan-prompt").fill("4米见方的平地，地形层数1，同时地形层数3。");
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-message")).toContainText("请澄清");
  await expect(page.locator("#plan-confirm")).toBeDisabled();
  expect(await page.locator("#scene-evidence").textContent()).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("wetland.plans.v1"))).toBeNull();
});

test("manual terrain edits expose intent differences before confirmation and preserve raw evidence", async ({ page }) => {
  const proposal = { ...demoPlan().proposal, amplitude: 0, octaves: 2 };
  const draft = await planScene("平地，地形层数二", async () => ({ raw: JSON.stringify(proposal), model: MODEL, done: true, doneReason: "stop" }), new AbortController().signal);
  await page.route("**/api/planner/generate", route => route.fulfill({ json: draft }));
  await page.locator("#plan-prompt").fill(draft.prompt);
  await page.locator("#plan-run").click();
  await expect(page.locator("#plan-summary")).toContainText("已核对明确");
  await page.locator("#plan-proposal").fill(JSON.stringify({ ...proposal, amplitude: 0.3 }));
  await page.locator("#plan-preview").click();
  await expect(page.locator("#plan-summary")).toContainText("待确认：当前配方与描述不同");
  await expect(page.locator("#plan-summary")).toContainText("amplitude=0，返回0.3");
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "20261002");
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#plan-message")).toContainText("场景已显示");
  const evidence = JSON.parse((await page.locator("#plan-evidence").textContent())!);
  expect(evidence.current).toMatchObject({kind: "manual", recipe: {amplitude: 0.3}, draft: {templateVersion: "parameters-v2", proposal: {amplitude: 0}}});
  expect(evidence.current.draft.attempts[0].raw).toBe(draft.attempts[0].raw);
});
