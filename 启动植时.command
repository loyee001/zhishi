#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 20 或更新版本，再运行植时。\n'
  read -r -p '按回车关闭…'
  exit 1
fi
printf '植时即将启动，请打开终端中显示的本地地址。\n'
node server.mjs
