#!/bin/zsh

set -euo pipefail

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

pause_on_error() {
  local message="$1"
  print -u2 -- "[YoomClaw] $message"
  if [[ -t 0 ]]; then
    print -u2 -- "按回车键关闭窗口。"
    read -r
  fi
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || pause_on_error "此启动脚本仅支持 macOS。"
[[ "$(uname -m)" == "arm64" ]] || pause_on_error "当前版本仅支持 Apple Silicon（arm64）。"

command -v node >/dev/null 2>&1 || pause_on_error "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 22 )) || pause_on_error "Node.js 版本过低，当前版本为 $(node --version)，需要 22 或更高版本。"

command -v pnpm >/dev/null 2>&1 || pause_on_error "未找到 pnpm，请先安装或通过 Corepack 启用 pnpm。"
[[ -f ".env" ]] || pause_on_error "缺少 .env。请先执行：cp .env.example .env，然后填写积墨 API 配置。"

if [[ ! -x "node_modules/.bin/concurrently" || ! -x "apps/desktop/renderer/node_modules/.bin/vite" || ! -x "apps/desktop/node_modules/.bin/electron" ]]; then
  print -- "[YoomClaw] 开发依赖缺失或处于生产模式，正在恢复依赖。"
  pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false || pause_on_error "依赖安装失败，请检查网络和 pnpm 配置。"
fi

[[ -x "node_modules/.bin/concurrently" ]] || pause_on_error "未找到 concurrently，请执行：pnpm install --frozen-lockfile --prod=false"
[[ -x "apps/desktop/renderer/node_modules/.bin/vite" ]] || pause_on_error "未找到 Vite，请执行：pnpm install --frozen-lockfile --prod=false"
[[ -x "apps/desktop/node_modules/.bin/electron" ]] || pause_on_error "未找到 Electron，请执行：pnpm install --frozen-lockfile --prod=false"

print -- "[YoomClaw] 项目目录：$PROJECT_DIR"
print -- "[YoomClaw] Node：$(node --version)"
print -- "[YoomClaw] pnpm：$(pnpm --version)"
print -- "[YoomClaw] 正在启动桌面应用；按 Control+C 停止。"

unset ELECTRON_RUN_AS_NODE
exec pnpm dev
