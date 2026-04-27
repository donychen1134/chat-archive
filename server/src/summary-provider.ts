import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { MessageRecord } from "./types.js";
import { buildTitleAndSummary } from "./rule-summary.js";
import { getSummarySettings, setSummaryLastError, type SummaryProvider } from "./settings.js";

export type SummaryResult = {
  title: string;
  summary: string;
  providerUsed: SummaryProvider;
  status: string;
};

let codexCircuitUntilMs = 0;
let codexCircuitReason = "";
let codexConsecutiveFailures = 0;

function pickEffectiveMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content.trim().length > 0)
    .slice(0, 24);
}

function conversationForPrompt(messages: MessageRecord[]): string {
  return pickEffectiveMessages(messages)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n")
    .slice(0, 12000);
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

function parseMetadataObject(raw: string): { title: string; summary: string } | null {
  const obj = parseFirstJsonObject(raw);
  if (!obj) return null;
  const titleRaw = typeof obj.title === "string" ? obj.title : "";
  const summaryRaw = typeof obj.summary === "string" ? obj.summary : "";
  const keywordsRaw = Array.isArray(obj.keywords)
    ? obj.keywords.filter((k): k is string => typeof k === "string").slice(0, 5)
    : [];
  const title = sanitizeTitle(titleRaw);
  if (!title) return null;
  const summaryText = summaryRaw.trim();
  const keywords = keywordsRaw.join(", ");
  const summary =
    summaryText && keywords
      ? `${summaryText} | 关键词: ${keywords}`
      : summaryText || (keywords ? `关键词: ${keywords}` : "暂未提炼出会话摘要。");
  return { title, summary };
}

function qwenApiUrl(): string {
  const base = (process.env.CHAT_ARCHIVE_QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").trim();
  if (base.endsWith("/chat/completions")) return base;
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function qwenApiKey(): string {
  return (process.env.CHAT_ARCHIVE_QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY ?? "").trim();
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

  const prompt = [
    "你在为一个编程会话生成元信息。",
    "只返回严格 JSON，键必须是：title, summary, keywords。",
    "要求：",
    "- title：不超过 80 字，聚焦用户真实意图，不要模板化措辞。",
    "- summary：一句简短中文总结，具体、贴近主题。",
    "- keywords：3-5 个关键词数组，优先中文；避免 skill/repo/prompt/instruction/code 等泛词。",
    "- 不要返回 markdown。",
    "会话内容：",
    content,
  ].join("\n");

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
      title: parsed.title,
      summary: parsed.summary,
      providerUsed: "qwen",
      status: "qwen_ok",
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

  const prompt = [
    "你在为一个编程会话生成元信息。",
    "只返回严格 JSON，键必须是：title, summary, keywords。",
    "要求：",
    "- title：不超过 80 字，聚焦用户真实意图，不要模板化措辞。",
    "- summary：一句简短中文总结，具体、贴近主题。",
    "- keywords：3-5 个关键词数组，优先中文；避免 skill/repo/prompt/instruction/code 等泛词。",
    "- 不要返回 markdown。",
    "会话内容：",
    content,
  ].join("\n");

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
      title: parsed.title,
      summary: parsed.summary,
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
    const base = buildTitleAndSummary(messages);
    return { ...base, providerUsed: "rule", status: "rule_only" };
  }

  if (provider === "qwen") {
    const byQwen = buildQwenSummary(messages, settings.model, settings.timeoutMs);
    if (byQwen.result) {
      setSummaryLastError("");
      return byQwen.result;
    }
    setSummaryLastError(byQwen.error);
    const fallback = buildTitleAndSummary(messages);
    return {
      ...fallback,
      providerUsed: "rule",
      status: `fallback_rule:${byQwen.error || "unknown error"}`,
    };
  }

  if (provider === "hybrid" && options.allowCodex === false) {
    const base = buildTitleAndSummary(messages);
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
  const fallback = buildTitleAndSummary(messages);
  return {
    ...fallback,
    providerUsed: "rule",
    status: `fallback_rule:${byCodex.error || "unknown error"}`,
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
  const byCodex = buildCodexSummary(fakeMessages, settings.model, settings.timeoutMs, { bypassCircuit: true });
  if (byCodex.result) {
    codexCircuitUntilMs = 0;
    codexCircuitReason = "";
    codexConsecutiveFailures = 0;
    return { ok: true, detail: "codex summary call succeeded" };
  }
  return { ok: false, detail: byCodex.error || "unknown error" };
}
