# Gaussian Scene Studio

### 从场景想法，到可审阅、可探索、可保存的湿地世界

一个面向大学生创新训练的三维场景研究原型。以湿地生态科普为首个主题，结合自然语言、资源约束与 Gaussian Splatting，让场景的来源、选择和修改过程都能被检查。

[English](README.en.md) · [快速运行](#快速运行) · [当前进度](#当前进度) · [本地模型](docs/LOCAL_MODELS.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

![研究路线概念图：资源约束生成和本机环境导入，通向网页浏览与未来的科普交互](docs/images/project-concept.svg)

> **当前阶段：研究原型。** 已有资源目录、人工审阅、可复现布局和本机SPZ环境导入。整场景外部生成尚未接入；真实河岸画质、知识热点与教学效果仍待验证。概念图展示研究路线，不是生成结果。

## 为什么做这个项目

“河岸上有低矮草丛和石头”看似简单，却包含需要检查的要求：河流是否出现、植被会不会挡住视线、石头来自扫描还是程序、已有地表能否承载这些元素。

- **需求能否被审阅？** 把模型的提议变成可编辑记录，保留缺失与冲突，交由使用者确认。
- **结果能否被重现？** 记录素材身份、种子、内容版本和相机，支持本地保存与离线重开。
- **场景能否服务教学？** 后续为人工核验的环境配置知识热点和探索任务，再评估学习效果。

自研重点是约束、知识组织、交互和评测；基础语言模型、扫描素材与外部世界生成后端使用已有技术，不宣称自研基础模型。

## 看看现在的样子

![实际浏览器河岸预览：Riverside扫描裁片与静态程序水面](docs/images/riverbank-preview.png)

**河岸候选 · 实际截图。** 地表来自 [VeryOS的Riverside](https://superspl.at/scene/8f52baf1)，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，使用连续裁片并保留署名；水面为程序Gaussian。此图是固定条件下的浏览器预览，不代表一句话生成成功。扫描柔化、水面平板感和裁边仍未通过画质验收。[验证范围](docs/validation/riverbank-review-preview-results.md)

| 本机整场景导入 | 返回原场景 |
|---|---|
| ![导入界面中的三点坐标测试夹具，非真实河岸](docs/images/environment-fixture.png) | ![返回后保留的程序湿地基线](docs/images/current-workbench.png) |
| World JSON + SPZ → 预览 → 保存 → 刷新重开。三点是**自制测试夹具，不是真实河岸**。 | 取消或返回保留原场景与相机。这里展示的是**程序湿地基线**。 |

[环境导入验证](docs/validation/environment-import-results.md) · [配图说明与署名](docs/images/README.md)

## 当前进度

文档更新于 **2026-10-08**；以下工程验收记录截至2026-10-07。

| 模块 | 已有能力 | 仍需完成或验证 |
|---|---|---|
| 资源目录与两阶段选材 | 7项登记，含4项试用与3项兼容素材；编辑需求、候选内选ID、来源确认、缺失反馈 | 候选规模有限；任意语言表达与跨环境泛化未验证 |
| 可复现布局 | 固定种子；边界、水位、坡度、间距和贴地检查；报告数量不足 | 高度代理不等于准确碰撞或生态适生性 |
| 河岸审阅与水体意图v2 | 可取消预览、使用后保存；“需要河流”与“已知水位”分开记录 | 未知水位保持待处理；原句到合格河岸的完整链路未通过 |
| 本机环境导入 | World JSON + SPZ；取消、本机保存、重开和`.wetenv`备份 | 没有内置付费生成入口；真实素材画质与大场景性能待验 |
| 版本与素材工具 | 旧场景包兼容、受控地表登记、可选离线SH3范围修正 | 不自动替换旧素材，不将色调修正当作清晰度提升 |
| 科普教学 | 湿地主题与知识交互方向已确定 | 知识热点、探索任务、教学评测尚未实现 |

环境导入支持 **gzip SPZ v2/v3、SH0–3**，最多25万点、64MiB源文件、32MiB流式解压；SPZ v4会明确拒绝。推荐先用100k档。本机最多保存8条环境、总源文件128MiB；技术保存成功不代表画质通过。

资源布局场景最多20个实例、25万个活跃高斯。Riverside裁片有64,949个SH3高斯，4×4是展示单位，不是实测米制。整场景背景不自动具备可编辑对象、物种标签或物理碰撞。

## 快速运行

需要Node.js、npm和支持WebGL2的桌面浏览器。已验证环境：Node 25.7.0、npm 11.10.1、macOS / Apple M5 16GB、Google Chrome；其他环境没有同等程度的验证。

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:4173/>：

1. **无模型体验：** 使用手动参数或“离线示例”，拖动旋转、右键平移、滚轮缩放；场景ZIP可保存后离线重开。
2. **导入已有环境：** 展开“导入环境 · 本机预览”，选择本地World JSON和SPZ，检查预览后保存或下载`.wetenv`备份。不要与场景ZIP混用。
3. **河岸审阅候选：** `/?review=1&planner=3b`为显式试用入口，需先配置本地模型。水位未明确时保留待处理状态。

仓库不包含模型权重或生成凭据。“默认回退 · 未解释输入”不代表模型理解了描述。导入本地SPZ不会调用外部生成服务。

### 可选：本地AI

已验证路线为 **Qwen2.5-3B-Instruct Q4_K_M + llama.cpp**。按[本地模型配置](docs/LOCAL_MODELS.md)准备权重和服务，再打开`/?planner=3b`。可以尝试：

> 湿地，扫描地表、2组程序碎石、4丛程序低草，种子42，水位0，4×4展示范围。

先审阅需求，再确认候选来源与数量。当前草、芦苇和可添加碎石为程序素材，不能冒称满足实拍素材需求。

[启动](启动湿地项目.command)与[停止](停止湿地项目.command)快捷入口依赖原开发Mac已有的运行器和校验权重，新电脑请先手动配置。脚本不会下载模型或安装运行器。

**Qwen 3B采用Qwen Research License，限非商业研究/评估；不能套用7B的Apache-2.0。** [完整许可说明](THIRD_PARTY_NOTICES.md)

## 技术结构

```text
src/selection/    两阶段需求与候选选材
src/review-v2/    水体意图与新版审阅合同
src/planner/      本地模型适配、规划与版本记录
src/environment/ SPZ校验、预览事务、独立存储与备份
src/assets/      资源目录、程序素材与摆放
src/terrain/     地形、水位和高度代理
src/gaussian/    Spark显示、生命周期与点数预算
src/io/          场景包、摘要和SH3素材包
scripts/         本机启动器与离线准备工具
tests/           浏览器回归与可重复夹具
```

主栈为TypeScript、Vite、Three.js、Spark、Vitest、Playwright，版本由lockfile固定。本地规划API随Vite开发/预览服务提供，纯静态托管不提供模型推理。

## 验证与研究边界

截至2026-10-07，**514条单元 + 8条启动器测试、类型检查、生产构建通过；Chrome功能回归110通过、15项条件跳过**。该次回归排除了8项旧视觉矩阵，不能写成所有浏览器测试或画质通过。独立审阅发现的初始化超时/取消问题已修复，并通过先失败后成功的回归验证。

```sh
npm test
npm run typecheck
npm run build
# 对应上述功能回归范围：
npx playwright test --project=functional --grep-invert 'offline river visibility'
```

浏览器测试使用已安装的Google Chrome和本机4173端口。`npm run test:e2e`还包含其他视觉用例，不等同于上述已通过范围。构建仍有大chunk提示。

[环境导入](docs/validation/environment-import-results.md) · [水体意图v2](docs/validation/water-semantics-v2-results.md) · [河岸预览](docs/validation/riverbank-review-preview-results.md) · [受控地表](docs/validation/controlled-ground-admission-results.md) · [SH3精度工具](docs/SH_IMPORT.md)

## 接下来的研究

- [ ] 用一份真实整场景SPZ验收河流、低草、岩石和本机资源占用。
- [ ] 以同后端、同预算比较原始提示、普通扩写和结构化约束，结合人工核验或盲评。
- [ ] 为合格环境人工配置3–5个知识热点和一个探索任务。
- [ ] 扩展至湿地植物带、食物关系观察、水质扰动对比等小场景。

这些是研究目标，不是已交付功能或效果保证。团队规模、外部预算和教学评测方案仍需明确。

## 许可与致谢

原创代码**尚未指定项目级开源许可证**；公开可见不等于可以按MIT使用。第三方软件、模型与素材各自保留原许可。

感谢Spark、Three.js、Qwen，以及VeryOS、Marcel Padilla、Loop CE。已分发素材保留来源、CC BY 4.0署名和修改说明。模型权重、个人存档、生成凭据、原始扫描大包与私有实验日志不随源码分发。[第三方说明](THIRD_PARTY_NOTICES.md)
