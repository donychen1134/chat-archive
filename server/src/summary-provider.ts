import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { MessageRecord } from "./types.js";
import { buildTitleAndSummary } from "./rule-summary.js";
import { getFridayAppId, getSummarySettings, setSummaryLastError, type SummaryProvider } from "./settings.js";

export type SummaryResult = {
  title: string;
  summary: string;
  purpose: string;
  target: string;
  outcome: string;
  keywords: string[];
  entities: Array<{ type: string; value: string }>;
  providerUsed: SummaryProvider;
  status: string;
};

export type CachedSummaryRecord = {
  title?: string | null;
  summary?: string | null;
  summary_provider?: string | null;
  summary_status?: string | null;
  session_purpose?: string | null;
  session_target?: string | null;
  session_outcome?: string | null;
  keywords_json?: string | null;
  entities_json?: string | null;
  summary_content_hash?: string | null;
  summary_model?: string | null;
  summary_prompt_version?: number | null;
  end_time?: string | null;
};

export type SyncSummaryResult = SummaryResult & {
  contentHash: string;
  model: string;
  promptVersion: number;
  fromCache: boolean;
};

export const SUMMARY_PROMPT_VERSION = 3;

let codexCircuitUntilMs = 0;
let codexCircuitReason = "";
let codexConsecutiveFailures = 0;

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

function effectiveMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content.trim().length > 0)
    .filter((m) => !isBoilerplate(m.content));
}

function pickEffectiveMessages(messages: MessageRecord[]): MessageRecord[] {
  const effective = effectiveMessages(messages);
  if (effective.length <= 18) return effective;
  const first = effective.slice(0, 6);
  const last = effective.slice(-12);
  const seen = new Set<string>();
  return [...first, ...last].filter((m) => {
    const key = m.id || `${m.role}:${m.ts}:${m.content.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function conversationForPrompt(messages: MessageRecord[]): string {
  return pickEffectiveMessages(messages)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n")
    .slice(0, 12000);
}

export function summaryContentHash(messages: MessageRecord[]): string {
  const content = effectiveMessages(messages)
    .map((m) => `${m.role}\u0000${m.content}`)
    .join("\u0001");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function parseFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tail(text: string, max = 500): string {
  const t = text.trim();
  if (!t) return "";
  return t.length > max ? t.slice(t.length - max) : t;
}

function extractSignal(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const picked = lines.filter((l) => /error|warning|failed|reconnect|timeout|disconnected/i.test(l));
  if (picked.length > 0) return tail(picked.join(" | "), 500);
  return "";
}

function proxyHint(): string {
  const hasProxy =
    Boolean(process.env.HTTPS_PROXY) ||
    Boolean(process.env.HTTP_PROXY) ||
    Boolean(process.env.ALL_PROXY) ||
    Boolean(process.env.https_proxy) ||
    Boolean(process.env.http_proxy) ||
    Boolean(process.env.all_proxy);
  return hasProxy ? "" : " (no proxy env in server process; restart server with HTTP(S)_PROXY)";
}

function buildCodexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const hasHttpProxy =
    Boolean(env.HTTPS_PROXY) || Boolean(env.HTTP_PROXY) || Boolean(env.https_proxy) || Boolean(env.http_proxy);

  // Prefer HTTP(S)_PROXY when present; some SOCKS-only ALL_PROXY setups can break websocket transport.
  if (hasHttpProxy) {
    delete env.ALL_PROXY;
    delete env.all_proxy;
  }
  return env;
}

function normalizeCodexError(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("failed to send websocket request") && d.includes("connection closed normally")) {
    return "proxy/network closed websocket transport; try using only HTTP(S)_PROXY and removing ALL_PROXY for codex";
  }
  if (d.includes("failed to lookup address information")) {
    return "dns lookup failed for chatgpt.com; check DNS/proxy settings";
  }
  if (d.includes("error sending request for url")) {
    return "https request failed to chatgpt backend; verify proxy and outbound access";
  }
  return detail;
}

function sanitizeTitle(value: string): string {
  const line = value.split("\n").find((v) => v.trim().length > 0)?.trim() ?? "未命名会话";
  const lower = line.toLowerCase();
  if (
    lower.startsWith("# ") ||
    lower.startsWith("## ") ||
    lower.startsWith("<command-message") ||
    lower.includes("instructions") ||
    lower === "hello" ||
    lower === "say hello" ||
    lower === "你好"
  ) {
    return "";
  }
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function cleanStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanText(item, maxLen);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanEntities(value: unknown): Array<{ type: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ type: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = cleanText(obj.type, 32).toLowerCase() || "topic";
    const entityValue = cleanText(obj.value, 120);
    if (!entityValue) continue;
    const key = `${type}:${entityValue.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type, value: entityValue });
    if (result.length >= 12) break;
  }
  return result;
}

function parseKeywordsFromSummary(summary: string): string[] {
  const m = summary.match(/(?:关键词|keywords)\s*[:：]\s*(.+)$/i);
  if (!m?.[1]) return [];
  return m[1]
    .split(/[、,，|]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function providerFromCache(value: string | null | undefined): SummaryProvider {
  return value === "codex" || value === "qwen" || value === "friday" || value === "hybrid" || value === "rule"
    ? value
    : "rule";
}

function cachedRecordToSummary(existing: CachedSummaryRecord, statusPrefix: string): SummaryResult | null {
  const title = sanitizeTitle(existing.title ?? "");
  const summary = cleanText(existing.summary ?? "", 500);
  if (!title || !summary) return null;
  const status = cleanText(existing.summary_status ?? "", 420);
  return {
    title,
    summary,
    purpose: cleanText(existing.session_purpose ?? "", 48),
    target: cleanText(existing.session_target ?? "", 120),
    outcome: cleanText(existing.session_outcome ?? "", 500),
    keywords: cleanStringArray(parseJsonArray(existing.keywords_json), 8, 48),
    entities: cleanEntities(parseJsonArray(existing.entities_json)),
    providerUsed: providerFromCache(existing.summary_provider),
    status: `${statusPrefix}${status ? `:${status}` : ""}`.slice(0, 500),
  };
}

function canUseStrongCache(existing: CachedSummaryRecord, provider: SummaryProvider): boolean {
  const status = (existing.summary_status ?? "").toLowerCase();
  if (status.startsWith("fallback_rule")) return false;
  const cachedProvider = providerFromCache(existing.summary_provider);
  if (cachedProvider === "rule" && provider !== "rule") return false;
  return true;
}

function activeWindowMs(): number {
  const hours = Number(process.env.CHAT_ARCHIVE_SUMMARY_ACTIVE_HOURS ?? "24");
  if (!Number.isFinite(hours) || hours < 0) return 24 * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

function isActiveSession(endTime: string | null | undefined): boolean {
  const windowMs = activeWindowMs();
  if (windowMs === 0) return false;
  const ts = endTime ? new Date(endTime).valueOf() : Date.now();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts <= windowMs;
}

function parseMetadataObject(raw: string): Omit<SummaryResult, "providerUsed" | "status"> | null {
  const obj = parseFirstJsonObject(raw);
  if (!obj) return null;
  const titleRaw = typeof obj.title === "string" ? obj.title : "";
  const summaryRaw = typeof obj.summary === "string" ? obj.summary : "";
  const title = sanitizeTitle(titleRaw);
  if (!title) return null;
  const summary = cleanText(summaryRaw, 500) || "暂未提炼出会话摘要。";
  const keywords = cleanStringArray(obj.keywords, 8, 48);
  return {
    title,
    summary,
    purpose: cleanText(obj.purpose, 48),
    target: cleanText(obj.target, 120),
    outcome: cleanText(obj.outcome, 500),
    keywords,
    entities: cleanEntities(obj.entities),
  };
}

function withRuleMetadata(base: { title: string; summary: string }): Omit<SummaryResult, "providerUsed" | "status"> {
  return {
    title: base.title,
    summary: base.summary,
    purpose: "",
    target: "",
    outcome: "",
    keywords: parseKeywordsFromSummary(base.summary),
    entities: [],
  };
}

function metadataPrompt(content: string): string {
  return [
    "你在为一个 AI 编程会话生成用于归档、检索和列表展示的结构化元信息。",
    "只返回严格 JSON，键必须是：title, summary, purpose, target, outcome, keywords, entities。",
    "字段要求：",
    "- title：单行，不超过 50 字，使用用户主要语言，像 opencode title 一样自然可检索；不要出现工具名、总结/生成等字样。",
    "- summary：1-2 句，具体说明用户要解决什么，以及会话中做了什么或得到了什么结论。",
    "- purpose：短标签，例如 功能开发、问题排查、代码评审、代码理解、文档写作、方案设计、运维查询、问题咨询。",
    "- target：主要对象，例如 repo、模块、文件、服务、pod、接口、文档、脚本、错误名；不要填泛词。",
    "- outcome：最终状态或结论；如果会话没有完成，说明当前停在什么问题上。",
    "- keywords：3-8 个关键词数组，优先保留精确技术词、错误、文件名、服务名；避免 codex/claude/skill/repo/instruction/session 等泛词。",
    "- entities：数组，每项为 {type,value}；type 可用 repo,file,service,error,command,api,pod,doc,topic。",
    "- 忽略 system/developer/tool 噪声，优先依据真实用户意图、关键 assistant 结论和最后状态。",
    "- 不要返回 markdown。",
    "会话内容：",
    content,
  ].join("\n");
}

function qwenApiUrl(): string {
  const base = (process.env.CHAT_ARCHIVE_QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").trim();
  if (base.endsWith("/chat/completions")) return base;
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function qwenApiKey(): string {
  return (process.env.CHAT_ARCHIVE_QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY ?? "").trim();
}

function fridayApiUrl(): string {
  const base = (process.env.CHAT_ARCHIVE_FRIDAY_BASE_URL ?? "https://aigc.sankuai.com/v1/openai/native").trim();
  if (base.endsWith("/chat/completions")) return base;
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function normalizeQwenModel(input: string): string {
  const m = (input || "").trim();
  if (!m) return "qwen-plus";
  if (m.includes("codex") || m.startsWith("gpt-")) return "qwen-plus";
  return m;
}

function buildQwenSummary(
  messages: MessageRecord[],
  model: string,
  timeoutMs: number
): { result: SummaryResult | null; error: string } {
  const content = conversationForPrompt(messages);
  if (!content) return { result: null, error: "empty conversation" };
  const apiKey = qwenApiKey();
  if (!apiKey) {
    return { result: null, error: "missing qwen api key: set CHAT_ARCHIVE_QWEN_API_KEY or DASHSCOPE_API_KEY" };
  }

  const prompt = metadataPrompt(content);

  const reqBody = JSON.stringify({
    model: normalizeQwenModel(model),
    temperature: 0.2,
    messages: [
      { role: "system", content: "你只输出严格 JSON，且内容使用简体中文。" },
      { role: "user", content: prompt },
    ],
  });

  const result = spawnSync(
    "curl",
    [
      "-sS",
      "--max-time",
      String(Math.max(3, Math.ceil(timeoutMs / 1000))),
      "-X",
      "POST",
      qwenApiUrl(),
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-d",
      reqBody,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs + 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    }
  );

  if (result.status !== 0) {
    return { result: null, error: tail(result.stderr || result.stdout || `qwen curl exit ${String(result.status)}`) };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  } catch {
    return { result: null, error: "qwen returned non-json response" };
  }
  if (payload.error && typeof (payload.error as Record<string, unknown>).message === "string") {
    return { result: null, error: `qwen api error: ${String((payload.error as Record<string, unknown>).message)}` };
  }

  const contentText =
    (((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content as
      | string
      | undefined) ?? "";
  const parsed = parseMetadataObject(contentText);
  if (!parsed) return { result: null, error: "qwen output is not valid JSON object" };
  return {
    result: {
      ...parsed,
      providerUsed: "qwen",
      status: "qwen_ok",
    },
    error: "",
  };
}

function buildFridaySummary(
  messages: MessageRecord[],
  model: string,
  timeoutMs: number
): { result: SummaryResult | null; error: string } {
  const content = conversationForPrompt(messages);
  if (!content) return { result: null, error: "empty conversation" };
  const appId = getFridayAppId();
  if (!appId) {
    return { result: null, error: "missing friday app id: set CHAT_ARCHIVE_FRIDAY_APP_ID or app_config friday.app_id" };
  }

  const prompt = metadataPrompt(content);
  const reqBody = JSON.stringify({
    model: model.trim() || "gpt-4.1-nano",
    temperature: 0.2,
    stream: false,
    messages: [
      { role: "system", content: "你只输出严格 JSON，且内容使用简体中文。" },
      { role: "user", content: prompt },
    ],
  });

  const result = spawnSync(
    "curl",
    [
      "-sS",
      "--max-time",
      String(Math.max(3, Math.ceil(timeoutMs / 1000))),
      "-X",
      "POST",
      fridayApiUrl(),
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${appId}`,
      "-d",
      reqBody,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs + 1000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    }
  );

  if (result.status !== 0) {
    return { result: null, error: tail(result.stderr || result.stdout || `friday curl exit ${String(result.status)}`) };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  } catch {
    return { result: null, error: `friday returned non-json response: ${tail(result.stdout || result.stderr || "", 240)}` };
  }
  if (payload.error && typeof (payload.error as Record<string, unknown>).message === "string") {
    return { result: null, error: `friday api error: ${String((payload.error as Record<string, unknown>).message)}` };
  }

  const contentText =
    (((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content as
      | string
      | undefined) ?? "";
  const parsed = parseMetadataObject(contentText);
  if (!parsed) return { result: null, error: "friday output is not valid JSON object" };
  return {
    result: {
      ...parsed,
      providerUsed: "friday",
      status: "friday_ok",
    },
    error: "",
  };
}

function buildCodexSummary(
  messages: MessageRecord[],
  model: string,
  timeoutMs: number,
  options?: { bypassCircuit?: boolean }
): { result: SummaryResult | null; error: string } {
  const bypassCircuit = options?.bypassCircuit ?? false;
  if (!bypassCircuit && Date.now() < codexCircuitUntilMs) {
    return {
      result: null,
      error: `codex circuit open: ${codexCircuitReason || "recent failures"}`,
    };
  }
  const content = conversationForPrompt(messages);
  if (!content) {
    return { result: null, error: "empty conversation" };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-archive-summary-"));
  const outFile = path.join(tmp, "last.txt");

  const prompt = metadataPrompt(content);

  const runCodex = (withOutputFile: boolean) =>
    spawnSync(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--model",
        model,
        ...(withOutputFile ? ["--output-last-message", outFile] : []),
        "-C",
        process.cwd(),
        "-",
      ],
      {
        input: prompt,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: buildCodexEnv(),
      }
    );

  let result = runCodex(true);

  // Retry once for transient websocket/http transport errors.
  if (result.status !== 0) {
    const transient = (result.stderr || result.stdout || "").toLowerCase();
    if (
      transient.includes("reconnecting") ||
      transient.includes("websocket") ||
      transient.includes("connection closed") ||
      transient.includes("stream disconnected")
    ) {
      result = runCodex(true);
    }
  }

  if (result.status !== 0) {
    const reason = normalizeCodexError(tail(result.stderr || result.stdout || ""));
    const err = reason || `codex exit ${String(result.status)}`;
    codexConsecutiveFailures += 1;
    if (codexConsecutiveFailures >= 3) {
      codexCircuitUntilMs = Date.now() + 60 * 1000;
      codexCircuitReason = err;
    }
    return { result: null, error: err };
  }
  let raw = "";
  if (fs.existsSync(outFile)) {
    raw = fs.readFileSync(outFile, "utf8").trim();
  }
  if (!raw) {
    raw = (result.stdout ?? "").trim();
  }
  // Some codex versions may not honor --output-last-message reliably; fallback to plain stdout mode once.
  if (!raw) {
    result = runCodex(false);
    raw = (result.stdout ?? "").trim();
  }
  if (!raw) {
    const signal = extractSignal(result.stderr ?? "");
    const detail = normalizeCodexError(signal || "codex returned no assistant output");
    const err = detail ? `empty output: ${detail}${proxyHint()}` : `empty output${proxyHint()}`;
    codexConsecutiveFailures += 1;
    if (codexConsecutiveFailures >= 3) {
      codexCircuitUntilMs = Date.now() + 60 * 1000;
      codexCircuitReason = err;
    }
    return {
      result: null,
      error: err,
    };
  }

  const parsed = parseMetadataObject(raw) ?? parseMetadataObject(result.stdout ?? "");
  if (!parsed) return { result: null, error: "output is not valid JSON object" };

  codexConsecutiveFailures = 0;
  return {
    result: {
      ...parsed,
      providerUsed: "codex",
      status: "codex_ok",
    },
    error: "",
  };
}

export function buildSessionMetadata(messages: MessageRecord[]): SummaryResult {
  return buildSessionMetadataWithOptions(messages, {});
}

export function buildSessionMetadataWithOptions(
  messages: MessageRecord[],
  options: { allowCodex?: boolean }
): SummaryResult {
  const settings = getSummarySettings();
  const provider = settings.provider;
  if (provider === "rule") {
    const base = withRuleMetadata(buildTitleAndSummary(messages));
    return { ...base, providerUsed: "rule", status: "rule_only" };
  }

  if (provider === "qwen") {
    const byQwen = buildQwenSummary(messages, settings.model, settings.timeoutMs);
    if (byQwen.result) {
      setSummaryLastError("");
      return byQwen.result;
    }
    setSummaryLastError(byQwen.error);
    const fallback = withRuleMetadata(buildTitleAndSummary(messages));
    return {
      ...fallback,
      providerUsed: "rule",
      status: `fallback_rule:${byQwen.error || "unknown error"}`,
    };
  }

  if (provider === "friday") {
    const byFriday = buildFridaySummary(messages, settings.model, settings.timeoutMs);
    if (byFriday.result) {
      setSummaryLastError("");
      return byFriday.result;
    }
    setSummaryLastError(byFriday.error);
    const fallback = withRuleMetadata(buildTitleAndSummary(messages));
    return {
      ...fallback,
      providerUsed: "rule",
      status: `fallback_rule:${byFriday.error || "unknown error"}`,
    };
  }

  if (provider === "hybrid" && options.allowCodex === false) {
    const base = withRuleMetadata(buildTitleAndSummary(messages));
    return { ...base, providerUsed: "rule", status: "hybrid_rule_budget" };
  }

  const byCodex = buildCodexSummary(messages, settings.model, settings.timeoutMs);
  if (byCodex.result) {
    setSummaryLastError("");
    codexCircuitUntilMs = 0;
    codexCircuitReason = "";
    codexConsecutiveFailures = 0;
    return byCodex.result;
  }

  // Keep last_error focused on root transport/model failures, not circuit-open wrappers.
  if (!byCodex.error.startsWith("codex circuit open:")) {
    setSummaryLastError(byCodex.error);
  }
  const fallback = withRuleMetadata(buildTitleAndSummary(messages));
  return {
    ...fallback,
    providerUsed: "rule",
    status: `fallback_rule:${byCodex.error || "unknown error"}`,
  };
}

export function buildSessionMetadataForSync(
  messages: MessageRecord[],
  existing: CachedSummaryRecord | undefined,
  options: { allowCodex?: boolean; endTime?: string | null } = {}
): SyncSummaryResult {
  const settings = getSummarySettings();
  const contentHash = summaryContentHash(messages);
  const cached =
    existing &&
    existing.summary_content_hash === contentHash &&
    existing.summary_model === settings.model &&
    Number(existing.summary_prompt_version ?? 0) === SUMMARY_PROMPT_VERSION &&
    canUseStrongCache(existing, settings.provider)
      ? cachedRecordToSummary(existing, "cache_hit")
      : null;
  if (cached) {
    return {
      ...cached,
      contentHash,
      model: settings.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
      fromCache: true,
    };
  }

  const inactiveExisting =
    existing && !isActiveSession(options.endTime ?? existing.end_time) ? cachedRecordToSummary(existing, "cache_inactive") : null;
  if (inactiveExisting) {
    return {
      ...inactiveExisting,
      contentHash,
      model: settings.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
      fromCache: true,
    };
  }

  const result = buildSessionMetadataWithOptions(messages, { allowCodex: options.allowCodex });
  return {
    ...result,
    contentHash,
    model: settings.model,
    promptVersion: SUMMARY_PROMPT_VERSION,
    fromCache: false,
  };
}

export function testCodexSummaryConnection(): { ok: boolean; detail: string } {
  const settings = getSummarySettings();
  const fakeMessages: MessageRecord[] = [
    {
      id: "1",
      session_id: "test",
      role: "user",
      ts: new Date().toISOString(),
      content: "请总结这个会话主题：排查 scheduler pod 的 label 规则。",
      turn_index: 1,
      seq_in_session: 1,
    },
  ];
  if (settings.provider === "rule") {
    return { ok: true, detail: "rule provider does not require connectivity test" };
  }
  if (settings.provider === "qwen") {
    const byQwen = buildQwenSummary(fakeMessages, settings.model, settings.timeoutMs);
    return byQwen.result
      ? { ok: true, detail: "qwen summary call succeeded" }
      : { ok: false, detail: byQwen.error || "unknown error" };
  }
  if (settings.provider === "friday") {
    const byFriday = buildFridaySummary(fakeMessages, settings.model, settings.timeoutMs);
    return byFriday.result
      ? { ok: true, detail: "friday summary call succeeded" }
      : { ok: false, detail: byFriday.error || "unknown error" };
  }
  const byCodex = buildCodexSummary(fakeMessages, settings.model, settings.timeoutMs, { bypassCircuit: true });
  if (byCodex.result) {
    codexCircuitUntilMs = 0;
    codexCircuitReason = "";
    codexConsecutiveFailures = 0;
    return { ok: true, detail: "codex summary call succeeded" };
  }
  return { ok: false, detail: byCodex.error || "unknown error" };
}
