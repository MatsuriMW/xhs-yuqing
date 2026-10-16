#!/bin/bash
# 启动小红书 MCP 和 n8n。n8n 开着，「定时触发」才会在 9:00 / 18:00 跑。
# 用法：./start.sh        前台跑 n8n（Ctrl+C 停）
#       ./start.sh once   不开界面，直接跑一次工作流
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
export N8N_RESTRICT_FILE_ACCESS_TO="$DIR/data"
export GENERIC_TIMEZONE=Asia/Shanghai
export N8N_RUNNERS_TASK_TIMEOUT=600
mkdir -p "$DIR/data/runs"
N8N="${N8N_BIN:-$(ls ~/.npm/_npx/*/node_modules/.bin/n8n 2>/dev/null | head -1)}"
[ -x "$N8N" ] || N8N="npx n8n"

if ! curl -s -o /dev/null -m 2 http://localhost:18060/mcp; then
  (cd ~ && nohup ./xiaohongshu-mcp-darwin-arm64 -headless=true > "$DIR/data/xhs-mcp.log" 2>&1 &)
  sleep 3
fi

if [ "$1" = "once" ]; then
  exec $N8N execute --id=XsYuqingV2Chuwu1
else
  exec $N8N start
fi
