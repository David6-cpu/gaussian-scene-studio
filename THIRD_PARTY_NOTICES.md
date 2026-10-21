# Third-party notices · 第三方许可说明

项目原创代码尚未选择项目级开源许可证。本文件整理第三方来源，不为其重新授权；仓库可见性和许可是不同事项。模型权重与完整原始扫描包不在源码分发中。

## 运行时依赖

| 软件 | 固定版本 | 原许可 |
|---|---|---|
| [Spark](https://github.com/sparkjsdev/spark) | 2.3.1 | MIT |
| [Three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.2 | MIT |

开发工具及传递依赖由 `package-lock.json` 记录，安装后的各包保留自己的 LICENSE。上表不是对整个依赖树或素材的统一授权。

## 模型：单独取得与使用

- **Qwen2.5-3B-Instruct-GGUF / Q4_K_M**：本项目验证的默认小模型路线。固定 revision `7dabda4d13d513e3e842b20f0d435c732f172cbe`，采用 **Qwen Research License Agreement**，许可授予非商业研究/评估用途，商业使用需另行取得相应许可。[官方模型](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF) · [固定版本许可](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/blob/7dabda4d13d513e3e842b20f0d435c732f172cbe/LICENSE)。
- **Qwen2.5-7B-Instruct-GGUF / Q4_K_M**：保留配置，尚未在本项目完成真实运行验收。固定 revision `bb5d59e06d9551d752d08b292a50eb208b07ab1f`，原许可为 **Apache-2.0**；不能把这份许可套用到 3B。[官方模型与许可](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/blob/bb5d59e06d9551d752d08b292a50eb208b07ab1f/LICENSE)。
- llama.cpp 与 Ollama 是可选本机运行器，不随本项目分发。使用其自身官方许可和发布说明。

仓库不提供权重下载器，不创建账号、密钥或付费订阅；模型来源、文件身份与使用条件由使用者按官方条款核对。模型别名本身不能证明加载了对应权重。

## 扫描资产

| 资产 | 作者 / 来源 | 许可 | 本仓库中的用途 |
|---|---|---|---|
| Riverside | [VeryOS](https://superspl.at/scene/8f52baf1) | CC BY 4.0 | 64,949 点原密度连续裁片，SH3；当前可回退地表试用 |
| Houseplant | [Marcel Padilla](https://github.com/marcelpadilla/splats/tree/c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411/data/plant) | CC BY 4.0 | 113,648 点 SH0；独立诊断，不当作湿地物种 |
| Rock | [Loop CE](https://loopce.com/gaussian-splats) | CC BY 4.0 | 197,251 点 SH0 连续裁片及作者参考照片；独立诊断，不是完整原始扫描包 |

保留以下具体来源、原许可、摘要与修改说明：

- [Riverside 原许可](public/assets/riverside-ground-v1/LICENSE.txt) 与 [来源和修改记录](public/assets/riverside-ground-v1/SOURCE.json)。
- [Houseplant 署名](public/diagnostics/houseplant/ATTRIBUTION.md) 与 [原许可](public/diagnostics/houseplant/SOURCE-LICENSE.txt)。
- [Rock 署名、裁切和参考照片说明](public/diagnostics/loopce-rock/ATTRIBUTION.md)。

展示变换、裁切、格式量化与可选清理均按实际记录注明。程序草、芦苇、碎石和水面明确标为程序素材，不能冒称第三方扫描。Daisy 与 Forest 的原始下载仅留在本机研究记录，没有作为新增素材随当前资源目录发布。

[CC BY 4.0 官方说明](https://creativecommons.org/licenses/by/4.0/)要求适当署名、许可链接和改动说明，不意味着作者认可本项目，也不提供画质或用途保证。


## Spark 解码器代码的许可声明

`src/gaussian/ext-decode.ts` 包含 Spark 2.3.1 解码函数的副本及项目适配。保留其原始版权和许可全文：

```text
The MIT License

Copyright © 2025 WORLD LABS TECHNOLOGIES, INC.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
