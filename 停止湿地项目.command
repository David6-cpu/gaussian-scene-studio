#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if [[ ! -x /opt/homebrew/bin/node ]]; then
  print '本机已有Node运行器未找到，请在启动终端按Ctrl-C停止。'
  read -r '?按回车关闭。'
  exit 1
fi
/opt/homebrew/bin/node scripts/local-launcher.mjs stop
result=$?
if [[ -t 0 ]]; then read -r '?查看停止结果后，按回车关闭。'; fi
exit $result
