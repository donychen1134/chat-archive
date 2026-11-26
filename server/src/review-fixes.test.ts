import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MessageRecord } from "./types.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "chat-archive-tests-"));
process.env.CHAT_ARCHIVE_HOME = testHome;
delete process.env.CHAT_ARCHIVE_QWEN_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
delete process.env.QWEN_API_KEY;

const search = await import("./search-utils.js");
const cleaning = await import("./message-cleaning.js");
const rules = await import("./rule-summary.js");
const settings = await import("./settings.js");
const summaries = await import("./summary-provider.js");
const codex = await import("./codex-ingest.js");
const database = await import("./db.js");

function message(content: string, role: "user" | "assistant" = "user", id = content.slice(0, 12)): MessageRecord {
  return {
    id,
    session_id: "test",
    role,
    ts: new Date().toISOString(),
    content,
    turn_index: 1,
    seq_in_session: role === "user" ? 0 : 1,
  };
}

test.after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

test("search helpers use bounded tokens and escape LIKE metacharacters", () => {
  assert.deepEqual(search.tokenizeSearchInput(" alpha   beta "), ["alpha", "beta"]);
  assert.equal(search.tokenizeSearchInput(new Array(20).fill("x").join(" ")).length, 20);
  assert.equal(search.buildFtsAnyQuery(["alpha", "beta"]), '"alpha" OR "beta"');
  assert.equal(search.escapeLikeToken("a\\b%c_d"), "%a\\\\b\\%c\\_d%");
  assert.equal(search.parseBoundedPositiveInt("bad", 20, 100), 20);
  assert.equal(search.parseBoundedPositiveInt("500", 20, 100), 100);
});

test("boilerplate blocks are removed without dropping the real request", () => {
  const raw = [
    "# AGENTS.md instructions",
    "<INSTRUCTIONS>internal rules</INSTRUCTIONS>",
    "<environment_context>cwd</environment_context>",
    "<recommended_plugins>plugin catalog</recommended_plugins>",
    "<skills_instructions>skill catalog</skills_instructions>",
    "帮我排查 scheduler 超时问题",
  ].join("\n");
  assert.equal(cleaning.stripBoilerplateContent(raw), "帮我排查 scheduler 超时问题");
  assert.equal(rules.buildTitleAndSummary([message(raw)]).title, "排查 scheduler 超时问题");
});

test("Codex App session metadata distinguishes roots, guardians, and spawned subagents", () => {
  const root = codex.codexSessionMetadataFromRecord({
    type: "session_meta",
    payload: { id: "root-id", thread_source: "user", source: "vscode" },
  });
  const guardian = codex.codexSessionMetadataFromRecord({
    type: "session_meta",
    payload: {
      id: "guardian-id",
      parent_thread_id: "root-id",
      thread_source: "subagent",
      source: { subagent: { other: "guardian" } },
    },
  });
  const subagent = codex.codexSessionMetadataFromRecord({
    type: "session_meta",
    payload: {
      id: "subagent-id",
      parent_thread_id: "root-id",
      thread_source: "subagent",
      source: { subagent: { thread_spawn: { depth: 1 } } },
    },
  });

  assert.deepEqual(root, {
    sessionKind: "user",
    nativeThreadId: "root-id",
    parentNativeThreadId: null,
    archiveVisible: true,
  });
  assert.deepEqual(guardian, {
    sessionKind: "guardian",
    nativeThreadId: "guardian-id",
    parentNativeThreadId: "root-id",
    archiveVisible: false,
  });
  assert.deepEqual(subagent, {
    sessionKind: "subagent",
    nativeThreadId: "subagent-id",
    parentNativeThreadId: "root-id",
    archiveVisible: true,
  });
});

test("Codex ingest hides Guardian transcripts, preserves usage, and cleans App context", () => {
  const sessionsDir = path.join(testHome, "codex-sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  process.env.CODEX_SESSIONS_DIR = sessionsDir;
  settings.setSummarySettings({ provider: "rule" });

  const rootPath = path.join(sessionsDir, "root.jsonl");
  const guardianPath = path.join(sessionsDir, "guardian.jsonl");
  const emptyPath = path.join(sessionsDir, "context-only.jsonl");
  const rootRecords = [
    {
      timestamp: "2026-08-18T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "root-thread", thread_source: "user", source: "vscode", cwd: "/tmp/root-project" },
    },
    {
      timestamp: "2026-08-18T10:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>catalog</recommended_plugins>" }] },
    },
    {
      timestamp: "2026-08-18T10:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我检查真实会话" }] },
    },
    {
      timestamp: "2026-08-18T10:00:03.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "检查完成" }] },
    },
    {
      timestamp: "2026-08-18T10:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } },
      },
    },
  ];
  const guardianRecords = [
    {
      timestamp: "2026-08-18T10:01:00.000Z",
      type: "session_meta",
      payload: {
        id: "guardian-thread",
        parent_thread_id: "root-thread",
        thread_source: "subagent",
        source: { subagent: { other: "guardian" } },
      },
    },
    {
      timestamp: "2026-08-18T10:01:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "The following is the Codex agent history whose request action you are assessing: repeated transcript" }],
      },
    },
    {
      timestamp: "2026-08-18T10:01:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"outcome\":\"allow\"}" }] },
    },
    {
      timestamp: "2026-08-18T10:01:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 900, output_tokens: 6, total_tokens: 906 } },
      },
    },
  ];
  fs.writeFileSync(rootPath, `${rootRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
  fs.writeFileSync(guardianPath, `${guardianRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
  fs.writeFileSync(
    emptyPath,
    `${[
      {
        timestamp: "2026-08-18T10:02:00.000Z",
        type: "session_meta",
        payload: { id: "context-only", thread_source: "user", source: "vscode" },
      },
      {
        timestamp: "2026-08-18T10:02:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<recommended_plugins>catalog</recommended_plugins>" }],
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`
  );

  const first = codex.syncCodexSessions();
  assert.equal(first.warnings, 0);
  assert.equal(first.updatedSessions, 2);
  assert.equal(
    (database.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE source_path = ?").get(emptyPath) as { count: number }).count,
    0
  );

  const root = database.db
    .prepare("SELECT id, session_kind, native_thread_id, archive_visible, message_count FROM sessions WHERE source_path = ?")
    .get(rootPath) as Record<string, unknown>;
  const guardian = database.db
    .prepare("SELECT id, session_kind, native_thread_id, parent_native_thread_id, archive_visible, message_count, summary_status FROM sessions WHERE source_path = ?")
    .get(guardianPath) as Record<string, unknown>;
  assert.equal(root.session_kind, "user");
  assert.equal(root.native_thread_id, "root-thread");
  assert.equal(root.archive_visible, 1);
  assert.equal(root.message_count, 2);
  assert.equal(guardian.session_kind, "guardian");
  assert.equal(guardian.parent_native_thread_id, "root-thread");
  assert.equal(guardian.archive_visible, 0);
  assert.equal(guardian.message_count, 0);
  assert.equal(guardian.summary_status, "internal_guardian");

  const rootMessages = database.db
    .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq_in_session")
    .all(root.id) as Array<{ role: string; content: string }>;
  assert.deepEqual(rootMessages, [
    { role: "user", content: "帮我检查真实会话" },
    { role: "assistant", content: "检查完成" },
  ]);
  assert.equal(
    (database.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(guardian.id) as { count: number }).count,
    0
  );
  assert.equal(
    (database.db.prepare("SELECT COUNT(*) AS count FROM message_fts WHERE session_id = ?").get(guardian.id) as { count: number }).count,
    0
  );
  assert.equal(
    (database.db.prepare("SELECT total_tokens FROM session_usage_summary WHERE session_id = ?").get(guardian.id) as { total_tokens: number })
      .total_tokens,
    906
  );

  const second = codex.syncCodexSessions();
  assert.equal(second.updatedSessions, 0);
  assert.equal(second.skippedFiles, 3);
});

test("rule summary rejects unbounded tokens", () => {
  const result = rules.buildTitleAndSummary([message("x".repeat(13_000))]);
  assert.ok(result.summary.length < 500);
  assert.equal(result.summary, "暂未提炼出关键词。");
});

test("prompt budgeting retains the final outcome", () => {
  const messages = [
    message(`开始分析 ${"x".repeat(16_000)}`, "user", "first"),
    message("最终确认根因是数据库连接池耗尽", "assistant", "last"),
  ];
  const prompt = summaries.conversationForPrompt(messages);
  assert.ok(prompt.length <= 12_000);
  assert.match(prompt, /最终确认根因是数据库连接池耗尽/);
});

test("cache status remains stable and cache keys include provider, model, and prompt version", () => {
  settings.setSummarySettings({ provider: "qwen", model: "qwen-plus" });
  const messages = [message("review search summary logic")];
  const hash = summaries.summaryContentHash(messages);
  const compatible = {
    title: "cached title",
    summary: "cached summary",
    summary_provider: "qwen",
    summary_status: "cache_non_rule:cache_non_rule:qwen_ok",
    summary_content_hash: hash,
    summary_model: "qwen-plus",
    summary_prompt_version: summaries.SUMMARY_PROMPT_VERSION,
    end_time: new Date().toISOString(),
  };
  const cached = summaries.buildSessionMetadataForSync(messages, compatible);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.status, "qwen_ok");

  settings.setSummarySettings({ provider: "friday", model: "gpt-4o-mini" });
  assert.equal(summaries.shouldRefreshUnchangedSummary(compatible), true);
});

test("remote summary age follows recent activity rather than session creation", () => {
  settings.setSummarySettings({ provider: "qwen", model: "qwen-plus" });
  const now = new Date();
  const old = new Date(now.valueOf() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const result = summaries.buildSessionMetadataForSync([message("recent update")], undefined, {
    startTime: old,
    endTime: now.toISOString(),
  });
  assert.notEqual(result.status, "remote_summary_expired");
});

test("hybrid codex budget persists zero", () => {
  settings.setSummarySettings({ codexLimitPerRun: 0 });
  assert.equal(settings.getSummarySettings().codexLimitPerRun, 0);
});

test("GPT 5.6 summary requests use the platform default temperature", () => {
  assert.deepEqual(summaries.summaryTemperatureOptions("gpt-5.6-terra"), {});
  assert.deepEqual(summaries.summaryTemperatureOptions("gpt-5.6-luna"), {});
  assert.deepEqual(summaries.summaryTemperatureOptions("gpt-4o-mini"), { temperature: 0.2 });
});
