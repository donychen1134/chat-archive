import type { MessageRecord } from "./types.js";

const STOP_WORDS_EN = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "have",
  "your",
  "about",
  "what",
  "when",
  "where",
  "which",
  "there",
  "would",
  "could",
  "please",
  "help",
  "skill",
  "skills",
  "repo",
  "root",
  "prompt",
  "prompts",
  "command",
  "commands",
  "instructions",
  "codex",
  "claude",
  "copilot",
  "gemini",
  "agent",
  "agents",
  "files",
]);

const STOP_WORDS_CN = new Set([
  "这个",
  "那个",
  "这里",
  "那里",
  "一个",
  "一些",
  "问题",
  "内容",
  "会话",
  "总结",
  "主题",
  "帮我",
  "请问",
  "分析",
  "需要",
  "目前",
  "当前",
  "可以",
  "如何",
  "为什么",
  "代码",
  "仓库",
  "命令",
  "提示词",
  "技能",
  "模型",
  "配置",
  "修复",
  "优化",
  "功能",
]);

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
  return messages.filter((m) => {
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (!m.content.trim()) return false;
    if (isBoilerplate(m.content)) return false;
    return true;
  });
}

function normalizedLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimTitle(value: string, max = 50): string {
  const title = normalizedLine(value).replace(/[。；;，,：:、\s]+$/g, "");
  if (title.length <= max) return title;

  const parts = title
    .split(/[。；;，,：:\n]/)
    .map((part) => normalizedLine(part))
    .filter((part) => part.length >= 4);
  const fitting = parts.find((part) => part.length <= max);
  if (fitting) return fitting;

  return `${title.slice(0, max - 3)}...`;
}

function replaceKnownUrls(value: string): string {
  return value
    .replace(/https?:\/\/tt\.sankuai\.com\/[^\s，,。；;]+/gi, "TT 工单")
    .replace(/https?:\/\/km\.sankuai\.com\/[^\s，,。；;]+/gi, "学城文档")
    .replace(/https?:\/\/ones\.sankuai\.com\/[^\s，,。；;]+/gi, "ONES 工作项")
    .replace(/https?:\/\/[^\s，,。；;]+/gi, "");
}

function stripRequestShell(value: string): string {
  let title = replaceKnownUrls(normalizedLine(value));
  title = title
    .replace(/^(?:请|麻烦|帮忙|帮我|帮|给我|能否|可以)?\s*(?:用|使用)\s+[^，,。；;]{1,60}?\s+skill[，,、\s]*/i, "")
    .replace(/^(?:请|麻烦|帮忙|帮我|帮|给我|能否|可以)\s*/i, "")
    .replace(/^(?:看一下|看下|看看|读一下|读取|读这个|分析一下|分析下)\s*/i, "")
    .replace(/^(?:当前|这个|下面|如下)\s*/i, "")
    .replace(/\s+mis\s+\w+$/i, "")
    .replace(/父文档\s*\d+/g, "")
    .replace(/群聊\s*(\d{6,})/g, "群聊 $1");

  if (/TT 工单/.test(title) && /读|看|分析|总结|详情/.test(value)) return "TT 工单分析";
  if (/学城文档/.test(title) && /写入|创建|发布/.test(value)) return trimTitle(title.replace(/将|把|文档/g, ""), 50);
  if (/学城文档/.test(title)) return "学城文档阅读";
  if (/ONES 工作项/.test(title)) return "ONES 工作项分析";
  if (/^review\s+the\s+code\s+changes/i.test(title) || /provide\s+prioritized,\s*actionable\s+findings/i.test(title)) {
    const base = title.match(/base branch ['"]?([A-Za-z0-9._/-]+)['"]?/i)?.[1];
    return base ? `${base} 分支代码变更审查` : "代码变更审查";
  }
  if (/写入.*学城|发布.*学城/.test(title)) {
    const file = title.match(/[A-Za-z0-9_.-]+\.(?:md|markdown|txt|docx?)/i)?.[0];
    return file ? trimTitle(`${file} 写入学城`) : "文档写入学城";
  }
  if (/pod/i.test(title) && /调度/.test(title) && /原因|没被调度|失败/.test(title)) return "Pod 调度结果差异原因分析";
  if (/java/i.test(title) && /报错|异常|error/i.test(title)) return "Java 程序报错分析";

  const colonIndex = title.search(/[：:]/);
  if (colonIndex > 6) {
    const before = title.slice(0, colonIndex);
    if (/报错|错误|异常|分析|排查|原因/.test(before)) title = before;
  }

  title = title
    .replace(/^(?:我的|当前目录下|当前目录|下面两个|下面)\s*/i, "")
    .replace(/的话/g, "")
    .replace(/是什么原因/g, "原因分析")
    .replace(/找原因/g, "原因分析")
    .replace(/帮我分析/g, "分析")
    .replace(/分析下/g, "分析")
    .replace(/分析一下/g, "分析")
    .replace(/帮我总结/g, "总结")
    .replace(/帮我看看/g, "")
    .replace(/看原因/g, "原因分析");

  return trimTitle(title);
}

function isWeakTitleLine(value: string): boolean {
  const line = normalizedLine(value);
  if (!line) return true;
  const lower = line.toLowerCase();
  if (
    lower.startsWith("# ") ||
    lower.startsWith("## ") ||
    lower.startsWith("<command-message") ||
    lower.startsWith("</command-message>") ||
    lower.includes("instructions") ||
    lower.includes("agent instructions") ||
    lower.includes("skills:") ||
    lower === "hello" ||
    lower === "say hello" ||
    lower === "你好" ||
    lower === "你好，你是什么模型" ||
    lower === "/status" ||
    lower === "/status " ||
    /^<[^>]+>$/.test(lower)
  ) {
    return true;
  }
  return false;
}

function pickBestTitle(messages: MessageRecord[]): string {
  const userMessages = messages.filter((msg) => msg.role === "user");
  for (const msg of userMessages) {
    const lines = msg.content
      .split("\n")
      .map((line) => normalizedLine(line))
      .filter(Boolean);
    for (const line of lines) {
      if (!isWeakTitleLine(line)) return stripRequestShell(line);
    }
  }
  const fallback = normalizedLine(userMessages[0]?.content.split("\n").find((line) => line.trim().length > 0) ?? "");
  return fallback ? stripRequestShell(fallback) : "未命名会话";
}

function topKeywords(text: string, max = 4): string[] {
  const enWords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS_EN.has(w));
  const cnWords = (text.match(/[\u4e00-\u9fff]{2,12}/g) ?? []).filter(
    (w) => !STOP_WORDS_CN.has(w)
  );
  const score = new Map<string, number>();
  for (const word of [...cnWords, ...enWords]) {
    score.set(word, (score.get(word) ?? 0) + 1);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
}

export function buildTitleAndSummary(messages: MessageRecord[]): { title: string; summary: string } {
  const effective = effectiveMessages(messages);
  const titleSource = effective.length > 0 ? effective : messages.filter((m) => m.role === "user" || m.role === "assistant");
  const firstLine = pickBestTitle(titleSource);
  const title = trimTitle(firstLine);

  const joined = (effective.length > 0 ? effective : messages.filter((m) => m.role === "user" || m.role === "assistant"))
    .slice(0, 12)
    .map((m) => m.content)
    .join("\n");
  const keywords = topKeywords(joined);
  const summary =
    keywords.length > 0
      ? `关键词: ${keywords.join("、")}`
      : "暂未提炼出关键词。";

  return { title, summary };
}
