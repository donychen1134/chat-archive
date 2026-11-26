import type { MessageRecord } from "./types.js";

const BLOCK_PATTERNS = [
  /# agents\.md instructions[\s\S]*?<\/instructions>/gi,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
  /<instructions>[\s\S]*?<\/instructions>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi,
  /<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/gi,
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,
  /<app-context>[\s\S]*?<\/app-context>/gi,
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

export function cleanMessageContentForArchive(role: MessageRecord["role"], text: string): string {
  if (role !== "user" && role !== "assistant") return text.trimEnd();
  return stripBoilerplateContent(text);
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
