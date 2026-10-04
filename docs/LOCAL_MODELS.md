# 本地模型配置 / Local model setup

先用 README 的手动/离线模式启动网页。AI 选材另需本机模型服务；没有权重时不需要为了查看项目而运行模型。下面的命令是使用说明，本仓库不会自动安装、下载、注册或付费。

## 已验证的 3B 路线

- Qwen2.5-3B-Instruct-GGUF，Q4_K_M；[官方来源](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF)。
- 固定 revision：`7dabda4d13d513e3e842b20f0d435c732f172cbe`。
- 文件：`qwen2.5-3b-instruct-q4_k_m.gguf`，2,104,932,768 字节。
- SHA-256：`626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d`。
- [Qwen Research 许可](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/blob/7dabda4d13d513e3e842b20f0d435c732f172cbe/LICENSE)：非商业研究/评估。不要使用 7B 的 Apache-2.0 来推断 3B 权利。

自行从官方来源取得有权使用的文件并核对摘要。保存到 `.local/models/` 等已忽略目录，勿提交权重、下载缓存或用户记录。

终端 A：使用本机已有、兼容所列参数的 `llama-server`（本项目验证过 llama.cpp build 10470）：

```sh
llama-server \
  --model /path/to/qwen2.5-3b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 \
  --alias qwen2.5-3b-instruct-q4_k_m \
  --ctx-size 4096 --parallel 1 --predict 1024 \
  --batch-size 128 --ubatch-size 128 --threads 4 \
  --cache-ram 0 --offline --no-webui --no-agent
```

这里的 `/path/to/` 是需替换的示例路径。命令须对应实际已核验文件，不要只改 alias 冒充其他模型。保留足够内存；单次观测不是所有机器的容量保证。

终端 B，在项目根目录：

```sh
npm run dev
```

打开 <http://127.0.0.1:4173/?planner=3b>，使用上方“两阶段选材”；原规划入口可选 llama.cpp 与 3B。服务只绑定本机，不要把模型端口直接对外公开。

完成后在两个终端分别按 Ctrl-C。关闭网页不会停止手动启动的模型。

## Mac 快捷入口

根目录的 `.command` 脚本只面向原开发机配置：Node 在 `/opt/homebrew/bin/node`，模型运行器版本路径由 `scripts/launcher-core.mjs` 指定，权重相对路径及摘要也固定在该文件。新电脑不会仅因克隆仓库就具备这些文件，应先采用上面的手动方式。启动器会做资源和进程归属检查，并拒绝覆盖或停止无关服务。

## 其他后端与边界

旧规划入口保留 Ollama / 7B 配置。模型存在检查只核对服务声明，不能单靠名称验证权重，也不代表完成真实推理验收。后端不可用时“默认回退”使用固定配方，仍需人工确认；不能将它算作输入语义成功。

The tested local AI path uses the 3B GGUF model and llama.cpp. Weights are not included. The current interface and evaluation prompts are primarily Chinese. The `.command` launchers require an existing, machine-specific runtime; they do not provide a portable installer.
