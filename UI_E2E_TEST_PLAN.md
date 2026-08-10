# YoomClaw 全流程 UI、真实 Jimo 与 Chrome 历史测试

## 快速运行

先确保没有正在运行的 YoomClaw/Gateway，并让 `.env` 中的 Jimo 配置通过环境变量注入：

```powershell
pnpm lint
pnpm test
pnpm build
pnpm --dir apps/desktop/renderer typecheck
pnpm --dir apps/desktop/renderer build
```

运行 Electron UI 测试。`--live` 是强制开关，避免误产生线上请求：

```powershell
pnpm test:e2e:ui -- --live --report-dir .tmp/yoomclaw-e2e
```

运行包含计划、文档读取和代码执行提示的完整 Agent 回归：

```powershell
pnpm test:e2e:ui -- --live --full-live --report-dir .tmp/yoomclaw-e2e
```

需要把 Chrome 历史也纳入门禁时，先用独立配置文件启动 Chrome，并完成后台登录：

```text
chrome.exe --remote-debugging-port=9222 --user-data-dir=<isolated-test-profile>
```

然后运行 UI-only RPA：

```powershell
node "web-automation/collect-jimo-history-rpa.mjs" `
  --cdp http://127.0.0.1:9222 `
  --url https://jimoai.xiaohuodui.cn/robot `
  --output .tmp/yoomclaw-e2e/jimo-history-rpa.json `
  --max-records 50 `
  --robot-keyword <目标机器人>
```

交叉核对 UI 测试报告和后台记录：

```powershell
pnpm test:e2e:history -- `
  --live-report .tmp/yoomclaw-e2e/<run-dir>/summary.json `
  --rpa-script "web-automation/collect-jimo-history-rpa.mjs" `
  --cdp http://127.0.0.1:9222 `
  --max-records 50
```

也可以由脚本启动独立 Chrome（登录仍需人工完成，脚本不会接触凭证）：

```powershell
pnpm test:e2e:chrome-history -- --start-chrome --wait-for-login `
  --cdp http://127.0.0.1:9222 `
  --url https://jimoai.xiaohuodui.cn/robot `
  --rpa-script "web-automation/collect-jimo-history-rpa.mjs" `
  --live-report .tmp/yoomclaw-e2e/<run-dir>/summary.json `
  --output .tmp/yoomclaw-e2e/jimo-history-rpa.json `
  --max-records 50
```

## 测试原则

- 每次运行使用独立 Electron profile、临时工作区和报告目录。
- 所有真实请求携带唯一 `[YC-E2E-...]` 标记和中文文件名。
- 测试脚本不读取 Cookie、LocalStorage、密码、Token 或生产 Chrome profile。
- 工作区外删除只允许操作测试创建的临时目录。
- RPA 必须打开详情，`detailsCollected=true` 且 `errors=[]`。
- UI 测试报告包含 `summary.json`、截图、HTML、文本快照、Renderer 输出和失败用例日志。

## 用例范围

脚本覆盖：

- Electron 最小化、最大化、还原和关闭策略；
- 侧栏、新建、搜索、选择、重命名、置顶、删除和宽度调整；
- 输入框、Enter/Shift+Enter、发送、停止、附件、复制、编辑、重试和导出；
- 三种访问权限、确认框和工作区外测试文件；
- 设置面板、Agent、Toolsets、Memory、Prompt、Browser、外观、通用和关于；
- 任务工作台；
- 中文聊天、首条输入作为会话标题、UTF-8 导出和乱码检测；
- 计划、文档读取、代码执行等真实 Jimo 工具提示；
- Gateway、WebSocket、Chrome CDP 和后台历史记录交叉核对。

## 稳定测试钩子

交互控件统一使用 `data-testid`。新增 UI 控件必须补充稳定 ID 和可访问名称，测试不得依赖颜色、图标 SVG 或易变 CSS 类名。

## 发布门禁

以下任一条件不满足，测试结果不得标记为通过：

- P0/P1 用例全部通过；
- Critical/High 缺陷为 0；
- `pnpm lint`、`pnpm test`、`pnpm build`、Renderer typecheck/build 全部通过；
- 中文输出不含乱码替换字符；
- 真实 Jimo 回复非空；
- RPA 详情无错误，并找到测试标记、文件名或会话标题；
- 复制/编辑按钮位于消息框外，左右间距一致；
- `full-access` 不再错误阻止临时工作区外测试文件，但不绕过 Windows 系统权限。
