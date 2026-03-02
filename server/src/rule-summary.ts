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
  const userFirst =
    effective.find((msg) => msg.role === "user")?.content.trim() ??
    messages.find((msg) => msg.role === "user")?.content.trim() ??
    "未命名会话";
  const firstLine = userFirst.split("\n").find((line) => line.trim().length > 0) ?? "未命名会话";
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;

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
