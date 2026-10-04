import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Riverside trial renders SH3, confirms planning, and survives self-contained ZIP and legacy rollback", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const evidence = async () =>
    JSON.parse((await page.locator("#scene-evidence").textContent())!);
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#algorithmVersion").selectOption("f0-riverside-v1");
  await page.locator("#generate").click();
  await expect
    .poll(async () => (await evidence()).recipe.algorithmVersion)
    .toBe("f0-riverside-v1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#algorithmVersion")).toHaveValue(
    "f0-riverside-v1",
  );
  expect((await evidence()).stats.ground).toEqual({
    id: "riverside-ground-v1",
    count: 64949,
    shBands: 3,
  });
  await expect(page.locator("#ground-credit")).toContainText("VeryOS");
  await expect(page.locator("#ground-credit a").first()).toHaveAttribute(
    "href",
    "https://superspl.at/scene/8f52baf1",
  );
  await page.locator("#plan-demo").click();
  await expect(page.locator("#plan-summary")).toContainText("Riverside");
  const reviewed = JSON.parse(
    await page.locator("#plan-proposal").inputValue(),
  );
  expect(reviewed.width).toBe(4);
  expect(reviewed.amplitude).toBe(0);
  await page.locator("#plan-confirm").click();
  await expect(page.locator("#status")).toHaveAttribute("data-seed", "42");
  await expect(page.locator("#plan-current")).toContainText("离线示例");
  expect((await evidence()).recipe.algorithmVersion).toBe("f0-riverside-v1");
  const [plan] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#plan-save").click(),
  ]);
  expect(
    JSON.parse(await readFile((await plan.path())!, "utf8")).recipe
      .algorithmVersion,
  ).toBe("f0-riverside-v1");
  const before = await evidence();
  const [zip] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#save").click(),
  ]);
  await page.locator("#algorithmVersion").selectOption("f0-v1");
  await page.locator("#generate").click();
  await expect
    .poll(async () => (await evidence()).recipe.algorithmVersion)
    .toBe("f0-v1");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  expect((await evidence()).stats.ground).toBeUndefined();
  await expect(page.locator("#ground-credit")).toBeHidden();
  // Block every asset fetch: ZIP import must carry native SH and cannot depend on cache/network.
  await page.route("**/assets/riverside-ground-v1/**", (route) =>
    route.abort(),
  );
  await page.locator("#bundle-file").setInputFiles((await zip.path())!);
  await expect(page.locator("#status")).toContainText("已导入");
  expect((await evidence()).recipe).toEqual(before.recipe);
  expect((await evidence()).stats).toEqual(before.stats);
  await expect(page.locator("#ground-credit")).toBeVisible();
  await page.locator("#clear").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "empty");
  expect((await evidence()).stats.ownedBytes).toBe(0);
  expect((await evidence()).stats.sourceBuffers).toBe(0);
  expect(errors).toEqual([]);
});

test("missing Riverside data gives an actionable error and the baseline can still load", async ({
  page,
}) => {
  await page.route("**/assets/riverside-ground-v1/**", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toContainText("Riverside");
  await page.locator("#algorithmVersion").selectOption("f0-v1");
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});

test("cancel aborts a pending ground fetch and retains the displayed baseline", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).includes("/assets/riverside-ground-v1/"))
        Object.assign(window, { groundLoadSignal: args[1]?.signal });
      return original(...args);
    };
  });
  await page.goto("/?surface=baseline");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/assets/riverside-ground-v1/**", async (route) => {
    await hold;
    await route.continue().catch(() => {});
  });
  try {
    await page.locator("#algorithmVersion").selectOption("f0-riverside-v1");
    await page.locator("#generate").click();
    await page.waitForFunction(() => Object.hasOwn(window, "groundLoadSignal"));
    await page.locator("#cancel").click();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { groundLoadSignal: AbortSignal })
            .groundLoadSignal.aborted,
      ),
    ).toBe(true);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "cancelled",
    );
    const evidence = JSON.parse(
      (await page.locator("#scene-evidence").textContent())!,
    );
    expect(evidence.recipe.algorithmVersion).toBe("f0-v1");
    expect(evidence.stats.ground).toBeUndefined();
  } finally {
    release();
  }
});

test("new planning can replace invalid manual fields without losing the selected ground", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#seed").fill("-1");
  await page.locator("#plan-demo").click();
  await expect(page.locator("#plan-confirm")).toBeEnabled();
  await expect(page.locator("#plan-summary")).toContainText("Riverside");
});
