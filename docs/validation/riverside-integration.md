# Riverside 扫描地表：分发摘要

本页保留资源目录引用需要的技术结论；原始机器日志、个人工作流记录和本机截图未随源码快照分发。

作者 VeryOS，CC BY 4.0。运行时使用原密度连续裁片，64,949 个高斯、SH3，保留固定六数组；4×4 范围是展示单位，不是实测米制。[许可](../../public/assets/riverside-ground-v1/LICENSE.txt)和[来源、摘要与修改记录](../../public/assets/riverside-ground-v1/SOURCE.json)随资产保留。

地表、水面和程序道具通过同一 Spark 链路渲染。高度代理用于水位和摆放，存在近似误差。扫描的柔化、拖尾与裁边仍在，不宣称整片地形具有准确碰撞或生态语义。

旧程序配方沿用 ZIP v1；Riverside 使用含六数组和署名元数据的 ZIP v2，读取时校验内容版本、固定摘要与规范重建结果。离线 SH3 variant 包是另一格式，不应混用。当前素材不能原地替换为修正版而继续使用旧内容身份。

行为检查见 [地表测试](../../src/terrain/riverside.test.ts)、[场景包测试](../../src/io/riverside-bundle.test.ts)和[浏览器测试](../../tests/e2e/riverside.spec.ts)。这些验证功能与重开合同，不构成最终画质验收。
