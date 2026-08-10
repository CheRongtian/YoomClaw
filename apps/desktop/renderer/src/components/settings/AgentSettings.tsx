import { useCallback, useEffect, useRef, useState } from "react";

const GATEWAY_URL = "http://localhost:18789";
const TOOLSETS = [
  ["coding", "编程"],
  ["memory", "记忆"],
  ["skills", "Skills"],
  ["browser", "浏览器"],
  ["planning", "计划"],
  ["web", "网页与搜索"],
  ["execution", "代码执行"],
  ["orchestration", "批量与子 Agent"],
  ["mcp", "MCP（可选）"],
  ["computer", "Computer Use（可选）"],
] as const;

type PromptTarget = "global" | "project" | "user";

interface HermesConfig {
  mode: "legacy" | "hermes";
  promptMode: "provider" | "local";
  autoMemoryReview: boolean;
  workspace: string;
  toolsets: string[];
  safetyMode: "confirm" | "workspace-auto" | "full-access";
  browserCdpUrl?: string;
  computerEnabled?: boolean;
  browser?: { connected: boolean; cdpUrl?: string; pageUrl?: string; message?: string };
  computer?: { enabled: boolean; available: boolean; platform?: string; helperVersion?: string; message?: string };
  agent?: { id: string; provider: string; model: string };
  imageHostConfigured: boolean;
  searchConfigured?: boolean;
  mcpConfigured?: boolean;
  prompts: Record<PromptTarget, string>;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft";
  tags: string[];
}

const EMPTY_CONFIG: HermesConfig = {
  mode: "hermes",
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
  computer: { enabled: false, available: false, platform: "win32" },
  agent: { id: "main", provider: "jimo", model: "gpt-5.6-luna" },
  imageHostConfigured: false,
  searchConfigured: false,
  mcpConfigured: false,
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
      setStatus(config.promptMode === "provider"
        ? "提示词已保存；当前对话使用 AI 服务“主题”中的静态规则"
        : "提示词已保存，新会话会使用最新内容");
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

  if (loading) return <div className="sp-empty">正在读取 Hermes 配置…</div>;

  return (
    <div className="agent-settings">
      <div className="agent-summary">
        <div>
          <div className="agent-kicker">YoomClaw</div>
          <div className="agent-heading">Hermes Mode</div>
          <div className="agent-hint">保留积墨 AI API，通过本地工作区、记忆和工具集完成任务。</div>
        </div>
        <span className={`status-pill ${config.mode === "hermes" ? "ok" : "warn"}`}>{config.mode}</span>
      </div>

      <div className="agent-section-title">工作区与安全</div>
      <div className="agent-row">
        <div>
          <div className="agent-label">主 Agent</div>
          <div className="agent-hint">当前只有一个主 Agent；图片由它直接理解，图片输入仍必须先经过图床转换为 HTTPS URL。</div>
        </div>
        <div className="prompt-mode-fixed" data-testid="main-agent-model">{config.agent?.model ?? "gpt-5.6-luna"}</div>
      </div>
      <div className="workspace-card">
        <div className="workspace-path" title={config.workspace}>{config.workspace || "未选择工作区"}</div>
        <button className="small-button" data-testid="agent-workspace-choose" onClick={() => void chooseWorkspace()}>选择文件夹</button>
      </div>
      <div className="agent-row">
        <div><div className="agent-label">Agent 模式</div><div className="agent-hint">Hermes Mode 使用本地持久化、记忆、Skills 和工具运行时；Legacy 保留旧 ReAct 行为。</div></div>
        <select data-testid="agent-mode" value={config.mode} onChange={(event) => void patchConfig({ mode: event.target.value })}>
          <option value="hermes">Hermes Mode</option>
          <option value="legacy">Legacy</option>
        </select>
      </div>
      <div className="agent-row">
        <div><div className="agent-label">访问权限</div><div className="agent-hint">请求批准、对风险操作自动审批，或打开完全访问；完全访问会取消应用层的文件与命令拦截。</div></div>
        <select data-testid="agent-safety-mode" value={config.safetyMode} onChange={(event) => void patchConfig({ safetyMode: event.target.value })}>
          <option value="confirm">请求批准</option>
          <option value="workspace-auto">替我审批</option>
          <option value="full-access">完全访问权限</option>
        </select>
      </div>

      <div className="agent-row">
        <div>
          <div className="agent-label">行为提示来源</div>
          <div className="agent-hint">Provider 模式固定使用 AI 服务的“主题”作为静态规则；当前任务、附件、文件路径和运行时权限仍由本地动态传入。</div>
        </div>
        <div className="prompt-mode-fixed" data-testid="agent-prompt-mode">Provider</div>
      </div>
      <div className="agent-row">
        <div>
          <div className="agent-label">完成后自动整理记忆</div>
          <div className="agent-hint">成功任务结束后提取稳定的项目事实和用户偏好；敏感信息仍会被过滤。</div>
        </div>
        <button className={`toolset ${config.autoMemoryReview ? "selected" : ""}`} data-testid="agent-auto-memory" onClick={() => void patchConfig({ autoMemoryReview: !config.autoMemoryReview })}>
          {config.autoMemoryReview ? "已开启" : "已关闭"}
        </button>
      </div>

      <div className="agent-section-title">Toolsets</div>
      <div className="toolset-grid">
        {TOOLSETS.map(([id, label]) => {
          const enabled = config.toolsets.includes(id);
          return <button key={id} className={`toolset ${enabled ? "selected" : ""}`} data-testid={`agent-toolset-${id}`} onClick={() => void patchConfig({ toolsets: enabled ? config.toolsets.filter((item) => item !== id) : [...config.toolsets, id] })}>{label}</button>;
        })}
      </div>

      <div className="agent-section-title">本地兼容提示词</div>
      <div className="prompt-mode-note" data-testid="agent-prompt-mode-note">
        当前使用 Provider 模式：请在 AI 服务的“主题”中保存静态规则。本页面内容仅作为本地兼容数据保留，不会作为静态提示词随聊天发送。
      </div>
      <div className="prompt-tabs">
        {(["global", "project", "user"] as PromptTarget[]).map((target) => <button key={target} data-testid={`agent-prompt-tab-${target}`} className={promptTarget === target ? "active" : ""} onClick={() => setPromptTarget(target)}>{target === "global" ? "全局 SOUL.md" : target === "project" ? "项目 AGENTS.md" : "用户偏好"}</button>)}
      </div>
      <textarea className="prompt-editor" data-testid="agent-prompt-editor" value={prompts[promptTarget] ?? ""} onChange={(event) => setPrompts((current) => ({ ...current, [promptTarget]: event.target.value }))} spellCheck={false} />
      <button className="primary-button" data-testid="agent-prompt-save" onClick={() => void savePrompt()}>保存提示词</button>

      <div className="agent-section-title">记忆</div>
      <textarea className="memory-editor" data-testid="agent-memory-editor" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="项目和环境中的长期事实" spellCheck={false} />
      <button className="small-button" data-testid="agent-memory-save" onClick={() => void saveMemory("memory")}>保存项目记忆</button>
      <textarea className="memory-editor" data-testid="agent-user-memory-editor" value={userMemory} onChange={(event) => setUserMemory(event.target.value)} placeholder="用户习惯和偏好" spellCheck={false} />
      <button className="small-button" data-testid="agent-user-memory-save" onClick={() => void saveMemory("user")}>保存用户记忆</button>

      <div className="agent-section-title">Skills</div>
      {skills.length === 0 ? <div className="agent-hint">暂无 Skill。Agent 成功完成可复用流程后可以生成草稿。</div> : skills.map((skill) => <div className="skill-row" key={skill.id}><div><div className="agent-label">{skill.name} {skill.status === "draft" && <span className="draft-label">草稿</span>}</div><div className="agent-hint">{skill.description || "无描述"}</div></div>{skill.status === "draft" && <span className="skill-actions"><button className="small-button" data-testid={`skill-apply-${skill.id}`} onClick={() => void applySkill(skill.id, "apply")}>启用</button><button className="small-button danger" data-testid={`skill-reject-${skill.id}`} onClick={() => void applySkill(skill.id, "reject")}>拒绝</button></span>}</div>)}

      <div className="agent-section-title">浏览器与电脑控制</div>
      <div className="browser-card">
        <div><div className="agent-label">图片上传链路</div><div className="agent-hint">图片先上传到自建图床，再把 HTTPS URL 交给主 Agent 的视觉能力。</div></div>
        <span className={"status-pill " + (config.imageHostConfigured ? "ok" : "warn")}>{config.imageHostConfigured ? "图床已连接" : "未配置图床"}</span>
      </div>
      <div className="browser-card">
        <div><div className="agent-label">Chrome CDP</div><div className="agent-hint">{config.browser?.connected ? `已连接：${config.browser.pageUrl || "当前页面"}` : "未连接。请用 --remote-debugging-port=9222 启动 Chrome。"}</div></div>
        <div className="browser-actions"><input data-testid="browser-cdp-url" value={config.browserCdpUrl ?? ""} onChange={(event) => setConfig((current) => ({ ...current, browserCdpUrl: event.target.value }))} onBlur={() => void patchConfig({ browserCdpUrl: config.browserCdpUrl })} /><button className="small-button" data-testid="browser-connect" onClick={() => void (config.browser?.connected ? disconnectBrowser() : connectBrowser())}>{config.browser?.connected ? "断开" : "连接"}</button></div>
      </div>
      <div className="browser-card">
        <div><div className="agent-label">Windows UI Automation</div><div className="agent-hint">{config.computer?.available ? `Helper ${config.computer.helperVersion ?? "ready"}` : (config.computer?.message ?? "Helper 未构建")}</div></div>
        <div className="browser-actions"><span className={"status-pill " + (config.computer?.available ? "ok" : "warn")}>{config.computer?.available ? "可用" : "不可用"}</span><button className="small-button" data-testid="computer-enabled" onClick={() => void patchConfig({ computerEnabled: !config.computerEnabled })}>{config.computerEnabled ? "已启用" : "默认关闭"}</button></div>
      </div>
      {status && <div className="agent-status">{status}</div>}

      <style jsx>{`
        .agent-settings { color: var(--text); }
        .agent-summary, .workspace-card, .browser-card, .skill-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .agent-summary { padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel); }
        .agent-kicker, .agent-section-title { color: var(--text-muted); font-size: 11px; letter-spacing: .6px; text-transform: uppercase; }
        .agent-heading { font-size: 16px; font-weight: 650; }
        .agent-hint { color: var(--text-muted); font-size: 11.5px; line-height: 1.5; }
        .agent-section-title { margin: 18px 0 7px; font-weight: 600; }
        .status-pill, .draft-label { border-radius: 999px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
        .status-pill.ok { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
        .status-pill.warn, .draft-label { color: var(--warning); background: color-mix(in srgb, var(--warning) 14%, transparent); }
        .workspace-card, .browser-card { padding: 10px 0; border-bottom: 1px solid var(--border-subtle); }
        .workspace-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
        .agent-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--border-subtle); }
        .agent-label { color: var(--text); font-size: 13px; }
        select, .browser-actions input { color: var(--text); background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; font-size: 12px; }
        .prompt-mode-fixed { color: var(--text); background: color-mix(in srgb, var(--primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent); border-radius: 7px; padding: 6px 8px; font-size: 12px; white-space: nowrap; }
        .toolset-grid, .prompt-tabs, .browser-actions, .skill-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .prompt-mode-note { margin: -2px 0 8px; padding: 9px 10px; color: var(--text-secondary); background: color-mix(in srgb, var(--primary) 8%, transparent); border: 1px solid color-mix(in srgb, var(--primary) 24%, transparent); border-radius: 8px; font-size: 11px; line-height: 1.55; }
        .toolset, .prompt-tabs button { border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; color: var(--text-secondary); font-size: 12px; }
        .toolset.selected, .prompt-tabs button.active { color: var(--text); border-color: var(--primary); background: color-mix(in srgb, var(--primary) 14%, transparent); }
        .prompt-editor, .memory-editor { display: block; width: 100%; min-height: 110px; resize: vertical; padding: 10px; color: var(--text); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; font: 12px/1.55 var(--font-mono); outline: none; }
        .prompt-editor:focus, .memory-editor:focus, .browser-actions input:focus { border-color: var(--primary); }
        .memory-editor { min-height: 75px; margin: 8px 0; }
        .primary-button, .small-button { border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; color: var(--text-secondary); font-size: 12px; }
        .primary-button { margin-top: 8px; border-color: var(--primary); color: var(--text); background: color-mix(in srgb, var(--primary) 14%, transparent); }
        .small-button:hover, .primary-button:hover { border-color: var(--border-active); color: var(--text); }
        .small-button.danger { color: var(--error); }
        .skill-row { padding: 9px 0; border-bottom: 1px solid var(--border-subtle); }
        .browser-actions input { width: 180px; font-family: var(--font-mono); }
        .agent-status { margin-top: 14px; color: var(--info); font-size: 12px; }
      `}</style>
    </div>
  );
}
