#!/bin/zsh
cd -- "${0:A:h}" || exit 1
source scripts/find-node.zsh
if ! find_node; then
  print '没有找到可用的 Node.js（需要 20.19+ 或 22.12+）。'
  print '请从 https://nodejs.org 安装 LTS 版本，或用 Homebrew / nvm 安装后重新双击本文件。不会自动安装软件。'
  read -r '?按回车关闭。'
  exit 1
fi
# The terminal owns the supervisor directly, so closing it delivers SIGHUP.
exec "$NODE" scripts/local-launcher.mjs start
