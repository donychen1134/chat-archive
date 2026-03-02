import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

type Scope = "all" | "question" | "answer";
type Role = "user" | "assistant" | "tool" | "system";
type ToolFilter = "codex" | "claude" | "copilot" | "gemini";
const ALL_TOOLS: ToolFilter[] = ["codex", "claude", "copilot", "gemini"];

interface Session {
  id: string;
  tool: string;
  start_time: string;
  end_time: string;
  duration_sec: number;
  title: string;
  summary: string;
  summary_provider?: string;
  summary_status?: string;
  message_count: number;
  native_session_id?: string | null;
  resume_command?: string;
  resume_label?: string;
}

interface SyncState {
  running: boolean;
  mode: "sync" | "reindex";
  startedAt: string;
  finishedAt: string;
  totalFiles: number;
  processedFiles: number;
  updatedSessions: number;
  skippedFiles: number;
  warnings: number;
  warningDetails: string[];
  currentFile: string;
  lastError: string;
}

interface SyncStartResponse {
  ok: boolean;
  started: boolean;
  state: SyncState;
}

interface Message {
  id: string;
  role: Role;
  ts: string;
  content: string;
  turn_index: number;
  seq_in_session: number;
}

interface ViewMessage extends Message {
  duplicateCount: number;
}

function parseSummary(summary: string): { headline: string; keywords: string } {
  const s = summary.trim();
  if (!s) return { headline: "", keywords: "" };

  const splitToken = "| Keywords:";
  const splitTokenCn = "| 关键词:";
  if (s.includes(splitToken) || s.includes(splitTokenCn)) {
    const [headline, keywordPart] = s.includes(splitToken) ? s.split(splitToken) : s.split(splitTokenCn);
    return {
      headline: headline.trim(),
      keywords: keywordPart.trim(),
    };
  }

  if (s.startsWith("Keywords:") || s.startsWith("关键词:")) {
    return {
      headline: "",
      keywords: s.slice(s.startsWith("关键词:") ? "关键词:".length : "Keywords:".length).trim(),
    };
  }

  return { headline: s, keywords: "" };
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function parseCodeBlocks(content: string): Array<{ kind: "text" | "code"; value: string; lang?: string }> {
  const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  const result: Array<{ kind: "text" | "code"; value: string; lang?: string }> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > last) {
      result.push({ kind: "text", value: content.slice(last, match.index) });
    }
    result.push({ kind: "code", lang: match[1] || "text", value: match[2] });
    last = regex.lastIndex;
  }
  if (last < content.length) {
    result.push({ kind: "text", value: content.slice(last) });
  }
  return result;
}

function isBoilerplate(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes("<permissions instructions>") ||
    value.includes("<instructions>") ||
    value.includes("# agents.md instructions") ||
    value.includes("<environment_context>") ||
    value.includes("<collaboration_mode>") ||
    value.includes("<cwd>") ||
    value.includes("</cwd>") ||
    value.includes("<user_shell_command>") ||
    value.includes("approved command prefix saved")
  );
}

function firstMeaningfulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!isBoilerplate(line)) return line;
  }
  return lines[0] ?? "(No user prompt)";
}

function lineIsImageTag(line: string): boolean {
  const v = line.trim().toLowerCase();
  return v.startsWith("<image name=") || v === "</image>" || v.startsWith("[image #");
}

function toAttachmentLabel(line: string): string | null {
  const m = line.trim().match(/<image name=\\[(.+?)\\]>/i);
  if (m?.[1]) return `Attachment: ${m[1]}`;
  if (line.trim().toLowerCase().startsWith("[image #")) return `Attachment: ${line.trim()}`;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const regex = new RegExp(`(${escapeRegExp(q)})`, "ig");
  const parts = text.split(regex);
  const qLower = q.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === qLower ? (
      <mark key={idx} className="hl">
        {part}
      </mark>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}

function renderTextWithAttachments(text: string, query: string): ReactNode[] {
  const lines = text.split("\n");
  return lines.map((line, idx) => {
    if (lineIsImageTag(line)) {
      const label = toAttachmentLabel(line);
      if (!label) return <div key={idx} className="attachment muted">Attachment</div>;
      return (
        <div key={idx} className="attachment">
          {label}
        </div>
      );
    }
    return (
      <span key={idx}>
        {highlightText(line, query)}
        {idx < lines.length - 1 ? "\n" : ""}
      </span>
    );
  });
}

function dedupeAdjacent(messages: Message[]): ViewMessage[] {
  const result: ViewMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.turn_index === msg.turn_index &&
      prev.role === msg.role &&
      prev.content === msg.content
    ) {
      prev.duplicateCount += 1;
      continue;
    }
    result.push({ ...msg, duplicateCount: 1 });
  }
  return result;
}

function MessageView({
  message,
  query,
  isCurrentMatch,
}: {
  message: ViewMessage;
  query: string;
  isCurrentMatch: boolean;
}) {
  const segments = useMemo(() => parseCodeBlocks(message.content), [message.content]);
  return (
    <div className={`message message-${message.role} ${isCurrentMatch ? "message-current-match" : ""}`} id={`msg-${message.id}`}>
      <div className="message-head">
        <strong>{message.role}</strong>
        <span>{formatTime(message.ts)}</span>
      </div>
      <div className="message-body">
        {segments.map((segment, idx) => {
          if (segment.kind === "code") {
            return (
              <SyntaxHighlighter key={idx} language={segment.lang} style={oneLight} customStyle={{ margin: "8px 0" }}>
                {segment.value}
              </SyntaxHighlighter>
            );
          }
          return (
            <pre key={idx} className="plain-text">
              {renderTextWithAttachments(segment.value, query)}
            </pre>
          );
        })}
        {message.duplicateCount > 1 && <div className="dup-note">重复 {message.duplicateCount} 次</div>}
      </div>
    </div>
  );
}

function groupTurns(messages: ViewMessage[]): Map<number, ViewMessage[]> {
  const grouped = new Map<number, ViewMessage[]>();
  for (const message of messages) {
    const items = grouped.get(message.turn_index) ?? [];
    items.push(message);
    grouped.set(message.turn_index, items);
  }
  return grouped;
}

export function App() {
  const [scope, setScope] = useState<Scope>("all");
  const [selectedTools, setSelectedTools] = useState<ToolFilter[]>(ALL_TOOLS);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [showSystemAndTool, setShowSystemAndTool] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [currentMatchMessageId, setCurrentMatchMessageId] = useState<string | null>(null);
  const [summaryProvider, setSummaryProvider] = useState<"codex" | "qwen" | "rule" | "hybrid">("rule");
  const [summaryModel, setSummaryModel] = useState("gpt-5-codex");
  const [summaryTimeoutMs, setSummaryTimeoutMs] = useState(20000);
  const [codexLimitPerRun, setCodexLimitPerRun] = useState(8);
  const [summaryLastError, setSummaryLastError] = useState("");
  const [summaryInfo, setSummaryInfo] = useState<string>("");
  const [summaryPanelOpen, setSummaryPanelOpen] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryTesting, setSummaryTesting] = useState(false);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [searching, setSearching] = useState(false);
  const [syncDetailOpen, setSyncDetailOpen] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const syncRunning = Boolean(syncState?.running);

  async function fetchSummarySettings() {
    try {
      const resp = await fetch("/api/summary/settings");
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        settings: {
          provider: "codex" | "qwen" | "rule" | "hybrid";
          model: string;
          timeoutMs: number;
          codexLimitPerRun: number;
          lastError: string;
        };
      };
      setSummaryProvider(data.settings.provider);
      setSummaryModel(data.settings.model);
      setSummaryTimeoutMs(data.settings.timeoutMs);
      setCodexLimitPerRun(data.settings.codexLimitPerRun ?? 8);
      setSummaryLastError(data.settings.lastError ?? "");
    } catch {
      setSummaryInfo("后端不可用，无法读取提炼配置。");
    }
  }

  async function saveSummarySettings() {
    setSummarySaving(true);
    try {
      const resp = await fetch("/api/summary/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: summaryProvider,
          model: summaryModel,
          timeoutMs: summaryTimeoutMs,
          codexLimitPerRun,
        }),
      });
      if (!resp.ok) {
        setSummaryInfo("保存失败");
        return;
      }
      setSummaryInfo("已保存");
      await fetchSummarySettings();
    } catch {
      setSummaryInfo("后端不可用，保存失败。");
    } finally {
      setSummarySaving(false);
    }
  }

  async function testSummaryProvider() {
    setSummaryTesting(true);
    try {
      const resp = await fetch("/api/summary/test", { method: "POST" });
      const data = (await resp.json()) as { ok: boolean; detail: string };
      setSummaryInfo(data.ok ? `测试成功: ${data.detail}` : `测试失败: ${data.detail}`);
      await fetchSummarySettings();
    } catch {
      setSummaryInfo("后端不可用，测试失败。");
    } finally {
      setSummaryTesting(false);
    }
  }

  async function fetchSessions() {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ scope, page: String(page), pageSize: String(pageSize) });
      if (selectedTools.length > 0 && selectedTools.length < ALL_TOOLS.length) {
        params.set("tools", selectedTools.join(","));
      }
      if (query.trim()) params.set("query", query.trim());
      const response = await fetch(`/api/sessions?${params.toString()}`);
      if (!response.ok) {
        setServerOk(true);
        if (response.status >= 500) {
          setError("后端正在处理任务或数据库忙，请稍后重试。");
        } else {
          setError(`读取会话失败: HTTP ${response.status}`);
        }
        return;
      }
      const data = (await response.json()) as { items: Session[]; total: number };
      setSessions(data.items);
      setTotalSessions(data.total);
      if (data.items.length > 0) {
        const hasSelected = selected ? data.items.some((s) => s.id === selected) : false;
        if (!hasSelected) {
          setSelected(data.items[0].id);
        }
      }
      setServerOk(true);
    } catch {
      setServerOk(false);
      setError("无法连接后端服务，请确认 server 已启动（127.0.0.1:8765）。");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSessionDetail(sessionId: string) {
    try {
      setError(null);
      const response = await fetch(`/api/session?id=${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        setServerOk(true);
        if (response.status === 404) {
          setError("会话详情不存在（可能后端未重启或索引已变化）。");
        }
        return;
      }
      const data = (await response.json()) as { messages: Message[] };
      setMessages(data.messages);

      const turnIndexes = Array.from(new Set(data.messages.map((m) => m.turn_index))).sort((a, b) => a - b);
      const collapsed = new Set<number>(turnIndexes);
      setCollapsedTurns(collapsed);
      setServerOk(true);
    } catch {
      setServerOk(false);
      setError("读取会话详情失败，请检查后端服务状态。");
    }
  }

  async function syncNow() {
    try {
      setSyncing(true);
      setError(null);
      const response = await fetch("/api/sync", { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const startData = (await response.json()) as SyncStartResponse;
      setSyncState(startData.state);
      if (!startData.started && startData.state.running) {
        return;
      }
      if (!startData.started && !startData.state.running) {
        throw new Error("sync task was not started");
      }
      await waitSyncTaskFinished();
      await fetchSessions();
      if (selected) {
        await fetchSessionDetail(selected);
      }
      setServerOk(true);
    } catch (error) {
      setServerOk(true);
      const detail = error instanceof Error ? error.message : String(error);
      setError(`同步失败：${detail || "后端同步报错"}`);
    } finally {
      setSyncing(false);
    }
  }

  async function reindexAll() {
    try {
      setReindexing(true);
      setError(null);
      const response = await fetch("/api/reindex", { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const startData = (await response.json()) as SyncStartResponse;
      setSyncState(startData.state);
      if (!startData.started && startData.state.running) {
        return;
      }
      if (!startData.started && !startData.state.running) {
        throw new Error("reindex task was not started");
      }
      await waitSyncTaskFinished();
      await fetchSessions();
      if (selected) {
        await fetchSessionDetail(selected);
      }
      setServerOk(true);
    } catch (error) {
      setServerOk(true);
      const detail = error instanceof Error ? error.message : String(error);
      setError(`全量重建失败：${detail || "后端重建报错"}`);
    } finally {
      setReindexing(false);
    }
  }

  async function fetchSyncStatus(): Promise<SyncState | null> {
    try {
      const response = await fetch("/api/sync/status");
      if (!response.ok) return null;
      const data = (await response.json()) as { ok: boolean; state: SyncState };
      setSyncState(data.state);
      return data.state;
    } catch {
      return null;
    }
  }

  async function waitSyncTaskFinished() {
    for (let i = 0; i < 600; i += 1) {
      const state = await fetchSyncStatus();
      if (!state) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      // Ignore initial idle state before sync task becomes visible to status endpoint.
      if (i < 4 && !state.running && state.totalFiles === 0 && state.processedFiles === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (!state.running) {
        if (state.lastError) {
          throw new Error(state.lastError);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("sync timeout");
  }

  useEffect(() => {
    void fetchSessions();
  }, [scope, selectedTools, page, pageSize]);

  useEffect(() => {
    if (!loading) setSearching(false);
  }, [loading]);

  useEffect(() => {
    void fetchSummarySettings();
    void fetchSyncStatus();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      const state = await fetchSyncStatus();
      if (stopped) return;
      timer = setTimeout(tick, state?.running ? 1000 : 5000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    void fetchSessionDetail(selected);
  }, [selected]);

  const visibleMessages = useMemo(() => {
    const base = dedupeAdjacent(messages);
    if (showSystemAndTool) return base;
    return base.filter((m) => m.role === "user" || m.role === "assistant");
  }, [messages, showSystemAndTool]);

  const turns = useMemo(() => groupTurns(visibleMessages), [visibleMessages]);

  const matchedMessages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as ViewMessage[];
    return visibleMessages.filter((m) => m.content.toLowerCase().includes(q));
  }, [visibleMessages, query]);

  useEffect(() => {
    setMatchIndex(0);
    setCurrentMatchMessageId(null);
  }, [selected, query]);

  useEffect(() => {
    const current = matchedMessages[matchIndex];
    if (!current) return;
    setCurrentMatchMessageId(current.id);
    setCollapsedTurns((prev) => {
      if (!prev.has(current.turn_index)) return prev;
      const next = new Set(prev);
      next.delete(current.turn_index);
      return next;
    });
    const el = document.getElementById(`msg-${current.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [matchedMessages, matchIndex]);

  const totalPages = Math.max(1, Math.ceil(totalSessions / pageSize));
  const currentStart = totalSessions === 0 ? 0 : (page - 1) * pageSize + 1;
  const currentEnd = Math.min(totalSessions, page * pageSize);

  function runSearch() {
    setSearching(true);
    if (page !== 1) {
      setPage(1);
      return;
    }
    void fetchSessions();
  }

  function toggleTool(tool: ToolFilter, multi: boolean) {
    setPage(1);
    setSelectedTools((prev) => {
      if (!multi) {
        return [tool];
      }
      if (prev.includes(tool)) {
        if (prev.length === 1) return prev;
        return prev.filter((t) => t !== tool);
      }
      return [...prev, tool];
    });
  }

  async function copyResumeCommand(session: Session) {
    const command = (session.resume_command ?? "").trim();
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedSessionId(session.id);
      window.setTimeout(() => {
        setCopiedSessionId((prev) => (prev === session.id ? null : prev));
      }, 1200);
    } catch {
      setError("复制失败：请检查浏览器剪贴板权限。");
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <span className="brand-dot" />
            </span>
            <h1>Chat Archive</h1>
          </div>
          <div className="toolbar-actions">
            <button
              className={`summary-launch-btn ${summaryPanelOpen ? "active" : ""}`}
              onClick={() => setSummaryPanelOpen((v) => !v)}
            >
              {summaryPanelOpen ? "关闭主题设置" : "主题提炼设置"}
            </button>
            <button onClick={() => void syncNow()} disabled={syncing || reindexing || syncRunning}>
              {syncRunning ? "Syncing..." : "Sync"}
            </button>
            <button onClick={() => void reindexAll()} disabled={syncing || reindexing || syncRunning}>
              {reindexing ? "Reindexing..." : syncRunning ? "Syncing..." : "Reindex All"}
            </button>
          </div>
        </div>
        <div className={`status-inline ${serverOk === false ? "status-error" : ""}`}>
          后端状态: {serverOk === null ? "未知" : serverOk ? "正常" : "不可用"}
          {syncState && (
            <span className="status-inline-progress">
              同步: {syncState.mode} {syncState.running ? "运行中" : "空闲"} | {syncState.processedFiles}/{syncState.totalFiles} |
              更新 {syncState.updatedSessions} | 警告 {syncState.warnings}
            </span>
          )}
          {syncState && (
            <button className="link-button" onClick={() => setSyncDetailOpen((v) => !v)}>
              {syncDetailOpen ? "隐藏详情" : "查看详情"}
            </button>
          )}
        </div>
        {syncState && (
          <>
            {syncDetailOpen && (
              <div className="sync-status">
                {syncState.running && syncState.processedFiles === 0 && syncState.totalFiles > 0 && (
                  <div className="sync-file">任务执行中；后端繁忙时进度可能延迟刷新。</div>
                )}
                {syncState.currentFile && <div className="sync-file">当前: {syncState.currentFile}</div>}
                {(syncState.warningDetails ?? []).length > 0 && (
                  <div className="sync-warnings">
                    {(syncState.warningDetails ?? []).map((item, idx) => (
                      <div key={idx} className="sync-warning-item">
                        {item}
                      </div>
                    ))}
                  </div>
                )}
                {syncState.lastError && <div className="summary-error">错误: {syncState.lastError}</div>}
              </div>
            )}
          </>
        )}
        <div className="top-search">
          <input
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                runSearch();
              }
            }}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="question">提问内容</option>
            <option value="answer">回答内容</option>
            <option value="all">全文</option>
          </select>
          <button onClick={runSearch} disabled={searching || loading}>
            {searching || loading ? "搜索中..." : "Search"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </header>

      <div className="content">
        <aside className="sidebar">
        <div className="tool-filter">
          <div className="tool-filter-title">CLI 过滤</div>
          <div className="tool-filter-actions">
            <button
              className={`tool-chip ${selectedTools.length === ALL_TOOLS.length ? "active" : ""}`}
              onClick={() => {
                setPage(1);
                setSelectedTools(ALL_TOOLS);
              }}
            >
              全部
            </button>
            <button
              className={`tool-chip ${selectedTools.includes("codex") ? "active" : ""}`}
              onClick={(e) => toggleTool("codex", e.metaKey || e.ctrlKey || e.shiftKey)}
            >
              Codex
            </button>
            <button
              className={`tool-chip ${selectedTools.includes("claude") ? "active" : ""}`}
              onClick={(e) => toggleTool("claude", e.metaKey || e.ctrlKey || e.shiftKey)}
            >
              Claude Code
            </button>
            <button
              className={`tool-chip ${selectedTools.includes("copilot") ? "active" : ""}`}
              onClick={(e) => toggleTool("copilot", e.metaKey || e.ctrlKey || e.shiftKey)}
            >
              Copilot
            </button>
            <button
              className={`tool-chip ${selectedTools.includes("gemini") ? "active" : ""}`}
              onClick={(e) => toggleTool("gemini", e.metaKey || e.ctrlKey || e.shiftKey)}
            >
              Gemini
            </button>
          </div>
          <div className="tool-filter-tip">点击为单选；按 Cmd/Ctrl/Shift 点击可多选。</div>
        </div>
        <div className="pager sidebar-pager">
          <div className="pager-row">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              上一页
            </button>
            <span>
              第 {page}/{totalPages} 页
            </span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              下一页
            </button>
          </div>
          <div className="pager-row">
            <span>
              显示 {currentStart}-{currentEnd} / {totalSessions}
            </span>
            <select
              value={String(pageSize)}
              onChange={(e) => {
                const nextSize = Number(e.target.value);
                setPageSize(nextSize);
                setPage(1);
              }}
            >
              <option value="10">10 / 页</option>
              <option value="20">20 / 页</option>
              <option value="50">50 / 页</option>
              <option value="100">100 / 页</option>
            </select>
          </div>
        </div>
        <div className="session-list">
          {loading && <div className="hint">Loading...</div>}
          {!loading && sessions.length === 0 && <div className="hint">No sessions</div>}
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-item ${selected === session.id ? "active" : ""}`}
              onClick={() => setSelected(session.id)}
            >
              {(() => {
                const parsed = parseSummary(session.summary);
                return (
                  <>
                    <div className="title">{session.title}</div>
                    <div className="meta">
                      <span className={`tool-badge tool-${session.tool}`}>
                        {session.tool === "claude"
                          ? "Claude Code"
                          : session.tool === "codex"
                            ? "Codex"
                            : session.tool === "copilot"
                              ? "Copilot"
                              : session.tool === "gemini"
                                ? "Gemini"
                                : session.tool}
                      </span>
                      <span>{formatTime(session.start_time)}</span>
                    </div>
                    {parsed.headline && <div className="summary-headline">{parsed.headline}</div>}
                    {parsed.keywords && <div className="summary-keywords">关键词：{parsed.keywords}</div>}
                    <div className="summary-meta">
                      {session.summary_provider ?? "rule"}
                      {session.summary_status?.startsWith("fallback_rule") ? " (fallback)" : ""}
                    </div>
                    {(session.resume_command ?? "").trim().length > 0 && (
                      <div className="resume-row">
                        <code className="resume-command" title={session.resume_command}>
                          {session.resume_command?.split("\n")[0]}
                        </code>
                        <button
                          type="button"
                          className="resume-copy-btn"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void copyResumeCommand(session);
                          }}
                        >
                          {copiedSessionId === session.id ? "已复制" : session.resume_label ?? "复制"}
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </button>
          ))}
        </div>
        </aside>

        <main className="main">
          {!selected && <div className="empty">请选择一个会话</div>}
          {selected && (
            <>
              <div className="turn-toolbar">
                <button onClick={() => setCollapsedTurns(new Set())}>展开全部</button>
                <button onClick={() => setCollapsedTurns(new Set(Array.from(turns.keys())))}>折叠全部</button>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={showSystemAndTool}
                    onChange={(e) => setShowSystemAndTool(e.target.checked)}
                  />
                  显示系统/工具消息
                </label>
                <span className="match-summary">
                  命中 {matchedMessages.length}
                  {matchedMessages.length > 0 ? ` (${matchIndex + 1}/${matchedMessages.length})` : ""}
                </span>
                <button
                  onClick={() => setMatchIndex((i) => (matchedMessages.length ? (i - 1 + matchedMessages.length) % matchedMessages.length : 0))}
                  disabled={matchedMessages.length === 0}
                >
                  上一个命中
                </button>
                <button
                  onClick={() => setMatchIndex((i) => (matchedMessages.length ? (i + 1) % matchedMessages.length : 0))}
                  disabled={matchedMessages.length === 0}
                >
                  下一个命中
                </button>
              </div>
              <div className="turns">
                {turns.size === 0 && <div className="hint">该会话暂无可显示消息</div>}
                {Array.from(turns.entries()).map(([turnIndex, turnMessages]) => {
                  const userQuestion =
                    firstMeaningfulLine(turnMessages.find((m) => m.role === "user")?.content ?? "(No user prompt)");
                  const collapsed = collapsedTurns.has(turnIndex);
                  return (
                    <section className="turn" key={turnIndex}>
                      <button
                        className="turn-head"
                        onClick={() => {
                          const next = new Set(collapsedTurns);
                          if (next.has(turnIndex)) next.delete(turnIndex);
                          else next.add(turnIndex);
                          setCollapsedTurns(next);
                        }}
                      >
                        <span>Turn {turnIndex}</span>
                        <span className="turn-question" title={userQuestion}>
                          {highlightText(userQuestion, query)}
                        </span>
                      </button>
                      {!collapsed && (
                        <div className="turn-body">
                          {turnMessages.map((message) => (
                            <MessageView
                              key={message.id}
                              message={message}
                              query={query}
                              isCurrentMatch={currentMatchMessageId === message.id}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>

      {summaryPanelOpen && (
        <div className="summary-drawer-mask" onClick={() => setSummaryPanelOpen(false)}>
          <aside className="summary-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="summary-drawer-head">
              <div>
                <strong>主题提炼设置</strong>
                <div className="summary-subtitle">配置 provider、模型和超时策略</div>
              </div>
              <button onClick={() => setSummaryPanelOpen(false)}>关闭</button>
            </div>
            <div className="summary-panel summary-panel-plain">
              <div className="summary-row">
                <span>Provider</span>
                <select value={summaryProvider} onChange={(e) => setSummaryProvider(e.target.value as "codex" | "qwen" | "rule" | "hybrid")}>
                  <option value="qwen">qwen</option>
                  <option value="hybrid">hybrid (推荐)</option>
                  <option value="codex">codex (全量)</option>
                  <option value="rule">rule</option>
                </select>
              </div>
              <div className="summary-row">
                <span>Model</span>
                <input value={summaryModel} onChange={(e) => setSummaryModel(e.target.value)} />
              </div>
              <div className="summary-row">
                <span>Timeout</span>
                <input
                  type="number"
                  value={summaryTimeoutMs}
                  onChange={(e) => setSummaryTimeoutMs(Number(e.target.value) || 20000)}
                />
              </div>
              <div className="summary-row">
                <span>Codex预算</span>
                <input
                  type="number"
                  value={codexLimitPerRun}
                  onChange={(e) => setCodexLimitPerRun(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
              {summaryInfo && <div className="summary-info">{summaryInfo}</div>}
              {summaryLastError && <div className="summary-error">最近失败: {summaryLastError}</div>}
            </div>
            <div className="summary-footer">
              <div className="summary-actions">
                <button onClick={() => void saveSummarySettings()} disabled={summarySaving || summaryTesting}>
                  {summarySaving ? "保存中..." : "保存设置"}
                </button>
                <button onClick={() => void testSummaryProvider()} disabled={summarySaving || summaryTesting}>
                  {summaryTesting ? "测试中..." : "测试 provider"}
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
