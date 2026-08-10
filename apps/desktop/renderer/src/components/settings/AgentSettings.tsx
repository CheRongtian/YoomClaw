import { useCallback, useEffect, useRef, useState } from "react";
import { SettingLabel, SettingRow, Toggle } from "./controls";

const GATEWAY_URL = "http://localhost:18789";
const TOOLSETS = [
  { id: "coding", label: "编程", term: "Coding", hint: "读写工作区并完成代码修改。" },
  { id: "memory", label: "记忆", term: "Memory", hint: "读取和保存项目及用户的长期记忆。" },
  { id: "skills", label: "技能", term: "Skills", hint: "管理可复用的技能和技能草稿。" },
  { id: "browser", label: "浏览器", term: "Browser", hint: "连接 Chrome 并操作网页。" },
  { id: "planning", label: "计划", term: "Planning", hint: "拆分任务并跟踪执行计划。" },
  { id: "web", label: "网页与搜索", term: "Web", hint: "搜索、抓取和提取网页内容。" },
  { id: "execution", label: "代码执行", term: "Execution", hint: "运行代码并读取执行结果。" },
  { id: "orchestration", label: "批量与子智能体", term: "Orchestration", hint: "并行执行任务或委派给子智能体。" },
  { id: "mcp", label: "外部工具", term: "MCP（可选）", hint: "发现并调用外部 MCP 工具。" },
  { id: "computer", label: "电脑控制", term: "Computer Use（可选）", hint: "通过 macOS 辅助功能操作桌面应用。" },
] as const;

type PromptTarget = "global" | "project" | "user";

interface HermesConfig {
  promptMode: "provider" | "local";
  autoMemoryReview: boolean;
  workspace: string;
  toolsets: string[];
  safetyMode: "confirm" | "workspace-auto" | "full-access";
  browserCdpUrl?: string;
  computerEnabled?: boolean;
  browser?: { connected: boolean; cdpUrl?: string; pageUrl?: string; message?: string };
  computer?: { enabled: boolean; available: boolean; platform?: string; helperVersion?: string; message?: string };
  prompts: Record<PromptTarget, string>;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft";
  tags: string[];
}

function computerHint(computer: HermesConfig["computer"]): string {
  if (computer?.platform && computer.platform !== "darwin") return "这个分支的电脑控制仅支持 macOS。";
  const message = computer?.message?.toLowerCase() ?? "";
  if (message.includes("disabled")) return "电脑控制已关闭。";
  if (message.includes("helper")) return "辅助程序 Helper 未构建。";
  if (message.includes("accessibility")) return "请在系统设置中授予辅助功能权限。";
  if (message.includes("screen recording")) return "窗口截图需要屏幕录制权限。";
  return "电脑控制当前不可用。";
}

const EMPTY_CONFIG: HermesConfig = {
  // The Provider's static topic is the assistant role; local prompt files are
  // retained only as an explicit fallback mode.
  promptMode: "provider",
  autoMemoryReview: false,
  workspace: "",
  toolsets: ["coding", "memory", "skills", "browser", "planning", "web", "execution", "orchestration"],
  safetyMode: "workspace-auto",
  browserCdpUrl: "http://127.0.0.1:9222",
  computerEnabled: false,
  browser: { connected: false },
  computer: { enabled: false, available: false, platform: "darwin" },
  prompts: { global: "", project: "", user: "" },
};

export default function AgentSettings() {
  const [config, setConfig] = useState<HermesConfig>(EMPTY_CONFIG);
  const [prompts, setPrompts] = useState<Record<PromptTarget, string>>(EMPTY_CONFIG.prompts);
  const [promptTarget, setPromptTarget] = useState<PromptTarget>("global");
  const [memory, setMemory] = useState("");
  const [userMemory, setUserMemory] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);
  const loadRequestRef = useRef(0);
  const workspaceReloadTimerRef = useRef<number | null>(null);
  const configMutationRef = useRef(0);
  const configQueueRef = useRef(Promise.resolve());
  const actionRevisionRef = useRef(0);

  useEffect(() => () => {
    aliveRef.current = false;
    if (workspaceReloadTimerRef.current !== null) {
      window.clearTimeout(workspaceReloadTimerRef.current);
      workspaceReloadTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const [configRes, memoryRes, skillsRes] = await Promise.all([
        fetch(`${GATEWAY_URL}/api/config`),
        fetch(`${GATEWAY_URL}/api/memory`),
        fetch(`${GATEWAY_URL}/api/skills`),
      ]);
      if (configRes.ok) {
        const next = { ...EMPTY_CONFIG, ...(await configRes.json()) } as HermesConfig;
        // Provider's external Topic is the configured source of static rules.
        // Migrate old local-mode data as soon as the settings page is opened.
        if (next.promptMode === "local") {
          next.promptMode = "provider";
          void fetch(`${GATEWAY_URL}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptMode: "provider" }),
          }).catch(() => {});
        }
        if (!aliveRef.current || requestId !== loadRequestRef.current) return;
        setConfig(next);
        setPrompts(next.prompts ?? EMPTY_CONFIG.prompts);
      }
      if (memoryRes.ok) {
        const data = (await memoryRes.json()) as { memory?: string; user?: string };
        if (!aliveRef.current || requestId !== loadRequestRef.current) return;
        setMemory(data.memory ?? "");
        setUserMemory(data.user ?? "");
      }
      if (skillsRes.ok) {
        const nextSkills = (await skillsRes.json()) as SkillSummary[];
        if (!aliveRef.current || requestId !== loadRequestRef.current) return;
        setSkills(nextSkills);
      }
      if (!aliveRef.current || requestId !== loadRequestRef.current) return;
      setStatus("");
    } catch (error) {
      if (aliveRef.current && requestId === loadRequestRef.current) {
        setStatus(error instanceof Error ? error.message : "Gateway 暂不可用");
      }
    } finally {
      if (aliveRef.current && requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchConfig = async (patch: Record<string, unknown>) => {
    const mutationId = ++configMutationRef.current;
    loadRequestRef.current += 1;
    setConfig((current) => ({ ...current, ...patch } as HermesConfig));
    const operation = configQueueRef.current.then(async () => {
      try {
        const response = await fetch(`${GATEWAY_URL}/api/config`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error("保存 Agent 配置失败");
        const next = (await response.json()) as HermesConfig;
        if (!aliveRef.current || mutationId !== configMutationRef.current) return;
        setConfig(next);
        setStatus("Agent 配置已保存");
      } catch (error) {
        if (!aliveRef.current || mutationId !== configMutationRef.current) return;
        setStatus(error instanceof Error ? error.message : "保存 Agent 配置失败");
        void load();
      }
    });
    configQueueRef.current = operation.then(() => undefined, () => undefined);
    await operation;
  };

  const savePrompt = async () => {
    const actionId = ++actionRevisionRef.current;
    try {
      const response = await fetch(`${GATEWAY_URL}/api/config/prompts/${promptTarget}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompts[promptTarget] }),
      });
      if (!aliveRef.current || actionId !== actionRevisionRef.current) return;
      if (!response.ok) {
        setStatus("保存提示词失败");
        return;
      }
      setStatus("提示词已保存");
    } catch (error) {
      if (aliveRef.current && actionId === actionRevisionRef.current) {
        setStatus(error instanceof Error ? error.message : "保存提示词失败");
      }
    }
  };

  const saveMemory = async (store: "memory" | "user") => {
    const actionId = ++actionRevisionRef.current;
    const content = store === "memory" ? memory : userMemory;
    try {
      const response = await fetch(`${GATEWAY_URL}/api/memory/${store}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!aliveRef.current || actionId !== actionRevisionRef.current) return;
      setStatus(response.ok ? "记忆已保存" : "记忆保存失败（可能包含敏感信息或超出大小限制）");
    } catch (error) {
      if (aliveRef.current && actionId === actionRevisionRef.current) {
        setStatus(error instanceof Error ? error.message : "记忆保存失败");
      }
    }
  };

  const chooseWorkspace = async () => {
    if (!window.yoomclaw?.chooseWorkspace) {
      setStatus("当前浏览器模式不支持选择工作区");
      return;
    }
    const workspace = await window.yoomclaw.chooseWorkspace();
    if (workspace) {
      setConfig((current) => ({ ...current, workspace }));
      setStatus("工作区已切换，Gateway 正在重启");
      if (workspaceReloadTimerRef.current !== null) {
        window.clearTimeout(workspaceReloadTimerRef.current);
      }
      workspaceReloadTimerRef.current = window.setTimeout(() => {
        workspaceReloadTimerRef.current = null;
        if (aliveRef.current) void load();
      }, 1200);
    }
  };

  const connectBrowser = async () => {
    const actionId = ++actionRevisionRef.current;
    try {
      const response = await fetch(`${GATEWAY_URL}/api/browser/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cdpUrl: config.browserCdpUrl }),
      });
      const data = (await response.json()) as HermesConfig["browser"] & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "连接 Chrome 失败");
      if (!aliveRef.current || actionId !== actionRevisionRef.current) return;
      setConfig((current) => ({ ...current, browser: data }));
    } catch (error) {
      if (!aliveRef.current || actionId !== actionRevisionRef.current) return;
      setStatus(error instanceof Error ? error.message : "连接 Chrome 失败");
      await load();
    }
  };

  const disconnectBrowser = async () => {
    const actionId = ++actionRevisionRef.current;
    try {
      const response = await fetch(`${GATEWAY_URL}/api/browser/disconnect`, { method: "POST" });
      if (!response.ok) throw new Error("断开 Chrome 失败");
      if (aliveRef.current && actionId === actionRevisionRef.current) await load();
    } catch (error) {
      if (aliveRef.current && actionId === actionRevisionRef.current) {
        setStatus(error instanceof Error ? error.message : "断开 Chrome 失败");
      }
    }
  };

  const applySkill = async (id: string, action: "apply" | "reject") => {
    const actionId = ++actionRevisionRef.current;
    try {
      const response = await fetch(`${GATEWAY_URL}/api/skills/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      if (!response.ok || !aliveRef.current || actionId !== actionRevisionRef.current) {
        if (aliveRef.current && actionId === actionRevisionRef.current) setStatus("Skill 操作失败");
        return;
      }
      setSkills((items) => action === "reject"
        ? items.filter((skill) => skill.id !== id)
        : items.map((skill) => skill.id === id ? { ...skill, status: "active" } : skill));
    } catch (error) {
      if (aliveRef.current && actionId === actionRevisionRef.current) {
        setStatus(error instanceof Error ? error.message : "Skill 操作失败");
      }
    }
  };

  if (loading) return <div className="sp-empty">正在读取智能体配置…</div>;

  return (
    <div className="agent-settings">
      <div className="agent-summary">
        <div>
          <div className="agent-kicker">YoomClaw</div>
          <div className="agent-heading">智能体配置</div>
          <div className="agent-hint">管理工作区、权限、工具集和记忆。</div>
        </div>
      </div>

      <div className="agent-section-title">工作区与安全</div>
      <div className="workspace-card">
        <div className="workspace-path" title={config.workspace}>{config.workspace || "未选择工作区"}</div>
        <button type="button" className="small-button" data-testid="agent-workspace-choose" onClick={() => void chooseWorkspace()}>选择文件夹</button>
      </div>
      <SettingRow
        label="访问权限"
        hint="请求批准、对风险操作自动审批，或打开完全访问；完全访问会取消应用层的文件与命令拦截。"
        control={(
          <select data-testid="agent-safety-mode" value={config.safetyMode} onChange={(event) => void patchConfig({ safetyMode: event.target.value })}>
            <option value="confirm">请求批准</option>
            <option value="workspace-auto">替我审批</option>
            <option value="full-access">完全访问权限</option>
          </select>
        )}
      />

      <SettingRow
        label="完成后自动整理记忆"
        hint="成功任务结束后提取稳定的项目事实和用户偏好；敏感信息仍会被过滤。"
        control={(
          <Toggle
            testId="agent-auto-memory"
            label="完成后自动整理记忆"
            checked={config.autoMemoryReview}
            onChange={(value) => void patchConfig({ autoMemoryReview: value })}
          />
        )}
      />

      <div className="agent-section-title">工具集 Toolsets</div>
      <div className="toolset-list">
        {TOOLSETS.map(({ id, label, term, hint }) => {
          const enabled = config.toolsets.includes(id);
          return (
            <SettingRow
              key={id}
              label={<SettingLabel label={label} term={term} />}
              hint={hint}
              control={(
                <Toggle
                  testId={`agent-toolset-${id}`}
                  label={`${label} ${term}`}
                  checked={enabled}
                  onChange={(value) => void patchConfig({ toolsets: value ? [...config.toolsets, id] : config.toolsets.filter((item) => item !== id) })}
                />
              )}
            />
          );
        })}
      </div>

      <div className="agent-section-title">提示词</div>
      <div className="prompt-mode-note" data-testid="agent-prompt-mode-note">
        提示词文件保存在当前工作区，便于跨会话维护项目和用户规则。
      </div>
      <div className="prompt-tabs">
        {(["global", "project", "user"] as PromptTarget[]).map((target) => <button type="button" key={target} data-testid={`agent-prompt-tab-${target}`} className={promptTarget === target ? "active" : ""} onClick={() => setPromptTarget(target)}>{target === "global" ? "全局 SOUL.md" : target === "project" ? "项目 AGENTS.md" : "用户偏好"}</button>)}
      </div>
      <textarea className="prompt-editor" data-testid="agent-prompt-editor" value={prompts[promptTarget] ?? ""} onChange={(event) => setPrompts((current) => ({ ...current, [promptTarget]: event.target.value }))} spellCheck={false} />
      <button type="button" className="primary-button" data-testid="agent-prompt-save" onClick={() => void savePrompt()}>保存提示词</button>

      <div className="agent-section-title">记忆</div>
      <textarea className="memory-editor" data-testid="agent-memory-editor" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="项目和环境中的长期事实" spellCheck={false} />
      <button type="button" className="small-button" data-testid="agent-memory-save" onClick={() => void saveMemory("memory")}>保存项目记忆</button>
      <textarea className="memory-editor" data-testid="agent-user-memory-editor" value={userMemory} onChange={(event) => setUserMemory(event.target.value)} placeholder="用户习惯和偏好" spellCheck={false} />
      <button type="button" className="small-button" data-testid="agent-user-memory-save" onClick={() => void saveMemory("user")}>保存用户记忆</button>

      <div className="agent-section-title">技能 Skills</div>
      {skills.length === 0 ? <div className="agent-hint">暂无技能。智能体 Agent 成功完成可复用流程后可以生成草稿。</div> : skills.map((skill) => <div className="skill-row" key={skill.id}><div><div className="agent-label">{skill.name} {skill.status === "draft" && <span className="draft-label">草稿</span>}</div><div className="agent-hint">{skill.description || "无描述"}</div></div>{skill.status === "draft" && <span className="skill-actions"><button type="button" className="small-button" data-testid={`skill-apply-${skill.id}`} onClick={() => void applySkill(skill.id, "apply")}>启用</button><button type="button" className="small-button danger" data-testid={`skill-reject-${skill.id}`} onClick={() => void applySkill(skill.id, "reject")}>拒绝</button></span>}</div>)}

      <div className="agent-section-title">浏览器与电脑控制</div>
      <div className="browser-card">
        <div><div className="agent-label">Chrome CDP</div><div className="agent-hint">{config.browser?.connected ? `已连接：${config.browser.pageUrl || "当前页面"}` : "未连接。请用 --remote-debugging-port=9222 启动 Chrome。"}</div></div>
        <div className="browser-actions"><input data-testid="browser-cdp-url" value={config.browserCdpUrl ?? ""} onChange={(event) => setConfig((current) => ({ ...current, browserCdpUrl: event.target.value }))} onBlur={() => void patchConfig({ browserCdpUrl: config.browserCdpUrl })} /><button type="button" className="small-button" data-testid="browser-connect" onClick={() => void (config.browser?.connected ? disconnectBrowser() : connectBrowser())}>{config.browser?.connected ? "断开" : "连接"}</button></div>
      </div>
      <div className="browser-card">
        <div><div className="agent-label">macOS 辅助功能控制</div><div className="agent-hint">{config.computer?.available ? `辅助程序 Helper ${config.computer.helperVersion ?? "ready"}；首次使用请授予辅助功能和屏幕录制权限。` : computerHint(config.computer)}</div></div>
        <div className="browser-actions"><span className={"status-pill " + (config.computer?.available ? "ok" : "warn")}>{config.computer?.available ? "可用" : "不可用"}</span><Toggle testId="computer-enabled" label="电脑控制 Computer Use" checked={!!config.computerEnabled} onChange={(value) => void patchConfig({ computerEnabled: value })} /></div>
      </div>
      {status && <div className="agent-status">{status}</div>}

      <style jsx>{`
        .agent-settings { color: var(--text); }
        .agent-summary, .workspace-card, .browser-card, .skill-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .agent-summary { padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-panel); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent); }
        .agent-kicker, .agent-section-title { color: var(--text-muted); font-size: 11px; letter-spacing: .3px; }
        .agent-heading { font-size: 17px; font-weight: 650; }
        .agent-hint { color: var(--text-muted); font-size: 12px; line-height: 1.55; }
        .agent-section-title { margin: 22px 0 8px; font-weight: 600; }
        .status-pill, .draft-label { border-radius: 999px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
        .status-pill.ok { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
        .status-pill.warn, .draft-label { color: var(--warning); background: color-mix(in srgb, var(--warning) 14%, transparent); }
        .workspace-card, .browser-card { padding: 12px 0; border-bottom: 1px solid var(--border-subtle); }
        .workspace-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
        .agent-label { color: var(--text); font-size: 13px; }
        select, .browser-actions input { color: var(--text); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font-size: 12px; min-height: 32px; }
        .toolset-list { overflow: hidden; margin-top: 2px; padding: 0 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-panel); }
        .prompt-tabs, .browser-actions, .skill-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .prompt-mode-note { margin: -2px 0 10px; padding: 10px 12px; color: var(--text-secondary); background: color-mix(in srgb, var(--primary) 8%, transparent); border: 1px solid color-mix(in srgb, var(--primary) 24%, transparent); border-radius: 9px; font-size: 11.5px; line-height: 1.55; }
        .prompt-tabs button { border: 1px solid var(--border); border-radius: 8px; padding: 7px 11px; color: var(--text-secondary); font-size: 12px; }
        .prompt-tabs button.active { color: var(--text); border-color: var(--primary); background: color-mix(in srgb, var(--primary) 14%, transparent); }
        .prompt-editor, .memory-editor { display: block; width: 100%; min-height: 110px; resize: vertical; padding: 10px; color: var(--text); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; font: 12px/1.55 var(--font-mono); outline: none; }
        .prompt-editor:focus, .memory-editor:focus, .browser-actions input:focus { border-color: var(--primary); }
        .memory-editor { min-height: 75px; margin: 8px 0; }
        .primary-button, .small-button { border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; color: var(--text-secondary); background: var(--bg-panel); font-size: 12.5px; font-weight: 500; }
        .primary-button { margin-top: 8px; border-color: var(--primary); color: var(--text); background: color-mix(in srgb, var(--primary) 14%, transparent); }
        .small-button:hover, .primary-button:hover { border-color: var(--border-active); color: var(--text); background: color-mix(in srgb, var(--bg-panel) 84%, var(--primary)); }
        .primary-button:hover { background: color-mix(in srgb, var(--primary) 20%, transparent); }
        .small-button.danger { color: var(--error); }
        .skill-row { padding: 11px 0; border-bottom: 1px solid var(--border-subtle); }
        .browser-actions input { width: 180px; font-family: var(--font-mono); }
        .agent-status { margin-top: 14px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--info) 26%, transparent); border-radius: 8px; color: var(--info); background: color-mix(in srgb, var(--info) 8%, transparent); font-size: 12px; }
      `}</style>
    </div>
  );
}
