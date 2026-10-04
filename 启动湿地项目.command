#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if [[ ! -x /opt/homebrew/bin/node ]]; then
  print '本机已有Node运行器未找到。请恢复原安装；不会自动安装软件。'
  read -r '?按回车关闭。'
  exit 1
fi
# The terminal owns the supervisor directly, so closing it delivers SIGHUP.
exec /opt/homebrew/bin/node scripts/local-launcher.mjs start
