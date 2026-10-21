#!/bin/zsh
cd -- "${0:A:h}" || exit 1
source scripts/find-node.zsh
if ! find_node; then
  print '没有找到可用的 Node.js，请在启动终端按Ctrl-C停止。'
  read -r '?按回车关闭。'
  exit 1
fi
"$NODE" scripts/local-launcher.mjs stop
result=$?
if [[ -t 0 ]]; then read -r '?查看停止结果后，按回车关闭。'; fi
exit $result
