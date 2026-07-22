import type { MessageRecord } from "./types.js";

const BLOCK_PATTERNS = [
  /# agents\.md instructions[\s\S]*?<\/instructions>/gi,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
  /<instructions>[\s\S]*?<\/instructions>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi,
  /<cwd>[\s\S]*?<\/cwd>/gi,
  /<user_shell_command>[\s\S]*?<\/user_shell_command>/gi,
];

export function stripBoilerplateContent(text: string): string {
  let cleaned = text;
  for (const pattern of BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, "\n");
  }
  return cleaned
    .split("\n")
    .filter((line) => !/approved command prefix saved/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function effectiveConversationMessages(messages: MessageRecord[]): MessageRecord[] {
  const result: MessageRecord[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = stripBoilerplateContent(message.content);
    if (!content) continue;
    result.push(content === message.content ? message : { ...message, content });
  }
  return result;
}
