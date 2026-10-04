# 离线 SH3 导入的可选范围修正

Spark 2.3.1 的 Ext SH 编码会对部分本可表示的系数截断。本项目提供显式 `range-safe` 选项，从保留的原始 PLY 重打包 SH；`native` 仍为默认。它不升级 Spark、不改原件、不替换目录素材，也不会恢复已经丢失的系数。

这是一项**离线素材准备工具**。输出是 `wetland-sh3-variant` 素材包，不是当前主页接受的 F0 场景 ZIP，不能直接拖入主页。准备好的包可由 `readSh3Variant()` 在独立检查页重开；候选仍需画质验收、明确版本与目录适配后才能进入主场景。

## 使用

在项目工作树根目录，使用本机已有支持 TypeScript 类型擦除的 Node（本次验证为 v25.7.0）：

```sh
node scripts/prepare-sh3-variant.ts \
  --ply /path/to/verified-crop.ply \
  --native /path/to/native.json \
  --out /path/to/new-variant.zip \
  --credit '作者 / 原始素材链接 / 许可及许可链接 / 裁切和展示变换说明' \
  --mode range-safe
```

省略 `--mode` 或指定 `--mode native` 时，完整保留输入六数组。输出路径必须不存在；工具拒绝覆盖，失败时不改输入。对公开素材必须填写真实署名、许可、来源和修改说明；这个文本字段本身不证明授权。

输入要求：

- 已核验的 binary little-endian、59 个 float 字段、完整 SH3 PLY；支持字段重排，按名称读取 45 个 `f_rest_*`。本版限定 LF 头部、单 vertex 元素，未知编码/元素明确拒绝。
- 同一 PLY 经现有 Spark 2.3.1 原生解码取得的 `native.json` 和同目录六数组；manifest 包含 `inputSha256`、`numSplats`、`shBands=3`、`capacity`、六项 `outputs` 和整体 `display`。不是将任意外部 JSON 当作已验证原生解码结果。
- 单对象 1–250,000 点，capacity 按 2,048 向上取整；原 PLY ≤64 MiB。所有源记录有限，中心和原生数组的顺序一致。
- 修正路径要求全部 SH 系数绝对值 ≤65,536；越界报错，不能静默饱和。极小系数仍可能量化为零。

## 保存和重开

工具先校验 PLY 与数组摘要、点数、字段、坐标顺序，再生成包并试读，最后独占创建新文件。包包含六数组、模式、源 PLY 摘要、点数、SH3、整体展示变换和署名。浏览器或 Node 可调用：

```ts
import { readSh3Variant } from "./src/io/sh3-variant.ts";
const { manifest, arrays } = await readSh3Variant(zipBytes);
// arrays.ext0/ext1 与四个 SH 数组交给现有 ExtSplats。
// manifest.mode 是 native 或 range-safe；不是全 float32 声明。
```

读包不依赖原 PLY、素材服务器或模型。它检查格式、预算、文件长度与摘要；摘要用于字节完整性，**不签名或认证 manifest 的语义**。只用于受信准备流程，不接受“改写 metadata 即获得来源授权/身份”的推断。

## 成本与限制

两种模式仍是相同的 32 字节几何/DC/透明度数据加 64 字节 SH 存储，每个已分配槽位 96 字节；修正不增点、不增加六数组字节数或 shader 采样。代价是准备时读原始 PLY、重新编码和另存包；同时保留两版自然占两份磁盘空间。

本次 XL 中心 126,807 点：六数组均为 11.625 MiB；修正包 12,192,108 字节，原生包大小只因模式文字不同而略差。单次准备约 404 ms，含源/数组校验和重新打包数据、未含之后 ZIP 保存与浏览器加载；不是长期性能承诺。主场景 250k **总**预算仍须另外检查，单素材合格不代表可任意堆叠。

`range-safe` 只是选择足以容纳当前 RGB 系数的共享指数。8 位幅值、共享指数、小系数下溢、几何/DC/透明度的既有量化仍存在。`accumExtSplats` 是另外的中间累积设置，不能恢复导入时已被截断的 SH；本工具不改全局 renderer 默认。

当前 Riverside 原素材与旧存档已固定六数组摘要，不能原地换成修正版。若后续要提供主页选项，应另建明确的素材/内容版本，扩展对应目录与场景包合同，并验证旧版保持原样；本轮没有做这一步。SOG/SPZ 等其他输入格式、真正 float32 SH shader 和自动升级依赖也不在本版范围内。

[根因、影响范围、数值与浏览器证据](validation/spark-sh-import-results.md)
