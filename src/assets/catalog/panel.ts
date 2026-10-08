import type { F0Recipe } from "../../gaussian/types";
import { assetCatalog } from "./entries";
import {BUILTIN_CONTEXT,type CatalogContext} from "./context";
import { wetlandBinding } from "./wetland";
import {
  biomeLabels,
  categoryLabels,
  parseRequirements,
  queryAssets,
} from "./query";

export function mountCatalogPanel(
  host: HTMLElement,
  getVersion: () => F0Recipe["algorithmVersion"],
  context:CatalogContext=BUILTIN_CONTEXT,
) {
  host.innerHTML = `<details id="catalog-details" class="planner-details">
    <summary>资源库与选材依据</summary>
    <p class="footnote">查询仅查看候选，不会修改场景或历史。当前描述入口调整湿地参数；AI自由选材尚未接入。</p>
    <p id="catalog-current"></p>
    <label class="planner-label">查询环境<select id="catalog-biome"><option value="wetland">湿地</option><option value="snow-mountain">雪山（待素材验证）</option></select></label>
    <label class="planner-label">素材类别<select id="catalog-category"><option value="ground">地表</option><option value="rock">碎石</option><option value="grass">草丛</option><option value="reed">芦苇候选</option><option value="plant-proxy">植株代理</option></select></label>
    <label class="planner-label">素材来源<select id="catalog-origin"><option value="either">实拍或程序</option><option value="captured">仅实拍</option><option value="procedural">仅程序</option></select></label>
    <p id="catalog-message" role="status" aria-live="polite"></p>
    <ul id="catalog-results"></ul>
    <p class="footnote">候选仅含已接入试用素材，旧版资源仍供历史重开。尺寸为展示单位，非实测米制；程序素材与实拍分开标明，缺失时不会自动替换。</p>
  </details>`;
  const node = <T extends HTMLElement = HTMLElement>(id: string) =>
    host.querySelector<T>(`#${id}`)!;
  const select = (id: string) => node<HTMLSelectElement>(id);
  function query() {
    const list = node("catalog-results");
    list.replaceChildren();
    try {
      const request = parseRequirements({
        biome: select("catalog-biome").value,
        unit: "display-unit",
        elements: [
          {
            key: "query",
            category: select("catalog-category").value,
            count: 1,
            origin: select("catalog-origin").value,
          },
        ],
      });
      const result = queryAssets(request,context.entries);
      const candidates = result.candidates[0].assets;
      node("catalog-message").textContent = result.missing.length
        ? `缺失：${result.missing.map((m) => m.message).join(" ")}`
        : `${biomeLabels[request.biome]} / ${categoryLabels[request.elements[0].category]}：${candidates.length} 项试用候选。查询不应用到当前画面。`;
      for (const asset of candidates) {
        const item = document.createElement("li");
        const line = (text: string, tag = "p") => {
          const element = document.createElement(tag);
          element.textContent = text;
          item.append(element);
        };
        line(asset.title, "strong");
        line(asset.id, "code");
        line(
          `${asset.origin === "captured" ? "第三方实拍" : "程序素材"} · ${asset.provenance.author} · ${asset.provenance.license === "project-internal" ? "项目内部使用，未新增对外许可" : asset.provenance.license}`,
        );
        const [width, height, depth] = asset.spatial.dimensions;
        line(
          `${asset.spatial.dimensionBasis === "usable-ground-area" ? "可用地表范围" : "摆放占地"} ${width} × ${depth} 展示单位；高度${height === null ? "未定标" : height}。向上 ${asset.spatial.upAxis}，朝向 ${asset.spatial.forwardAxis ?? "未指定"}。`,
        );
        line(
          `完整 ${asset.gaussian.full.toLocaleString()} 点；粗略 ${asset.gaussian.coarse === null ? "无" : asset.gaussian.coarse.toLocaleString() + " 点"}。源数据 ${(asset.gaussian.sourceBytes / 1048576).toFixed(2)} MiB。`,
        );
        line(`限制：${asset.quality.limitations.join("；")}`);
        if (asset.origin === "captured") {
          const source = document.createElement("a");
          source.href = asset.provenance.source;
          source.target = "_blank";
          source.rel = "noopener noreferrer";
          source.textContent = "查看原始来源";
          item.append(source);
        } else line(`生成来源：${asset.provenance.source}`);
        list.append(item);
      }
    } catch {
      node("catalog-message").textContent = "查询条件无效，未应用素材。";
    }
  }
  function update() {
    const binding = wetlandBinding(getVersion());
    const describe = (id: string) => {
      const a = assetCatalog.find((entry) => entry.id === id)!;
      return `${id}（${a.origin === "captured" ? "第三方实拍" : "程序"}${a.quality.status === "legacy" ? "，旧版保留" : "，试用"}）`;
    };
    node("catalog-current").textContent =
      `所选预设的资源绑定：${binding.ground ? describe(binding.ground) : "程序地表（公共PCG层）"}；${describe(binding.rock)}；${describe(binding.reed)}。修改预设后需生成才更新画面。`;
  }
  for (const id of ["catalog-biome", "catalog-category", "catalog-origin"])
    select(id).addEventListener("change", query);
  update();
  query();
  return { update };
}
