import type { MessageRecord } from "./types.js";

const STOP_WORDS = new Set([
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
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const score = new Map<string, number>();
  for (const word of words) {
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
    "Untitled Session";
  const firstLine = userFirst.split("\n").find((line) => line.trim().length > 0) ?? "Untitled Session";
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;

  const joined = (effective.length > 0 ? effective : messages.filter((m) => m.role === "user" || m.role === "assistant"))
    .slice(0, 12)
    .map((m) => m.content)
    .join("\n");
  const keywords = topKeywords(joined);
  const summary =
    keywords.length > 0
      ? `Keywords: ${keywords.join(", ")}`
      : "Auto summary is not available for this session.";

  return { title, summary };
}
