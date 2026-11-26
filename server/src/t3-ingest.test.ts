import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "chat-archive-t3-tests-"));
process.env.CHAT_ARCHIVE_HOME = testHome;
delete process.env.CHAT_ARCHIVE_QWEN_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
delete process.env.QWEN_API_KEY;

const settings = await import("./settings.js");
const database = await import("./db.js");
const t3Ingest = await import("./t3-ingest.js");

function createT3FixtureDb(dbFile: string): InstanceType<typeof Database> {
  const source = new Database(dbFile);
  source.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      role TEXT NOT NULL,
      streaming INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      parent_item_id TEXT,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      run_attempt_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
  `);
  return source;
}

test.after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

test("T3 ingest imports active/archived threads, skips deleted & rolled-back turns, and tracks usage & incremental cleanup", () => {
  const fixturePath = path.join(testHome, "statev2.sqlite");
  process.env.T3_STATE_DB_PATH = fixturePath;
  settings.setSummarySettings({ provider: "rule" });

  const src = createT3FixtureDb(fixturePath);
  try {
    src.prepare(
      `INSERT INTO projection_projects(project_id, title, workspace_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("proj-real", "my-service", "/tmp/work/my-service", "2026-11-24T07:00:00.000Z", "2026-11-24T07:00:00.000Z");

    src.prepare(
      `INSERT INTO projection_projects(project_id, title, workspace_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("proj-scratch", "No project", "/tmp/home/.t3/scratch", "2026-11-25T03:00:00.000Z", "2026-11-25T03:00:00.000Z");

    // 1. Active thread with 1 completed run + 1 rolled_back run
    src.prepare(
      `INSERT INTO orchestration_v2_projection_threads(
        thread_id, project_id, title, default_provider, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "thread-active",
      "proj-real",
      "发布前代码变更检查",
      "antigravity",
      "2026-11-24T07:14:26.000Z",
      "2026-11-24T07:25:00.000Z",
      null,
      null,
      JSON.stringify({
        modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
        lineage: { parentThreadId: null, rootThreadId: "thread-active" },
      })
    );

    src.prepare(
      `INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "run-1",
      "thread-active",
      1,
      "antigravity",
      "completed",
      "2026-11-24T07:14:26.000Z",
      "2026-11-24T07:19:50.000Z",
      JSON.stringify({ modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } })
    );

    src.prepare(
      `INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "run-2-rolled-back",
      "thread-active",
      2,
      "antigravity",
      "rolled_back",
      "2026-11-24T07:20:00.000Z",
      "2026-11-24T07:21:00.000Z",
      JSON.stringify({ modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } })
    );

    const insertMsg = src.prepare(
      `INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    );
    insertMsg.run(
      "msg-1",
      "thread-active",
      "run-1",
      "user",
      "2026-11-24T07:14:26.000Z",
      "2026-11-24T07:14:26.000Z",
      JSON.stringify({ text: "帮我 review master 分支代码风险", attachments: [{ type: "file", name: "diff.patch" }] })
    );
    insertMsg.run(
      "msg-2",
      "thread-active",
      "run-1",
      "assistant",
      "2026-11-24T07:19:50.000Z",
      "2026-11-24T07:19:50.000Z",
      JSON.stringify({ text: "整体风险可控，建议关注两处边界条件。" })
    );
    insertMsg.run(
      "msg-3-rb",
      "thread-active",
      "run-2-rolled-back",
      "user",
      "2026-11-24T07:20:00.000Z",
      "2026-11-24T07:20:00.000Z",
      JSON.stringify({ text: "这条消息已被回滚，不应出现在归档中" })
    );

    const insertItem = src.prepare(
      `INSERT INTO orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`
    );
    insertItem.run(
      "item-1",
      "thread-active",
      "run-1",
      1,
      "dynamic_tool",
      "2026-11-24T07:15:00.000Z",
      JSON.stringify({ toolName: "Read" })
    );
    insertItem.run(
      "item-2",
      "thread-active",
      "run-1",
      2,
      "command_execution",
      "2026-11-24T07:15:01.000Z",
      JSON.stringify({ title: "Workspace ready" })
    );
    insertItem.run(
      "item-3",
      "thread-active",
      "run-1",
      3,
      "file_search",
      "2026-11-24T07:15:02.000Z",
      JSON.stringify({ title: "Search code" })
    );

    const insertTurn = src.prepare(
      `INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at, completed_at, payload_json)
       VALUES (?, ?, 'pt-1', 'node-1', ?, 'completed', ?, ?, ?)`
    );
    insertTurn.run(
      "turn-1",
      "thread-active",
      1,
      "2026-11-24T07:14:27.000Z",
      "2026-11-24T07:19:50.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageStatus: "complete",
          inputTokens: 10000,
          cachedInputTokens: 8000,
          cacheCreationTokens: 0,
          outputTokens: 500,
          reasoningTokens: 120,
        },
      })
    );
    insertTurn.run(
      "turn-2-rb",
      "thread-active",
      2,
      "2026-11-24T07:20:01.000Z",
      "2026-11-24T07:21:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageStatus: "complete",
          inputTokens: 99999,
          outputTokens: 999,
        },
      })
    );

    // 2. Archived scratch subagent thread (should be kept, project=null, session_kind='subagent')
    src.prepare(
      `INSERT INTO orchestration_v2_projection_threads(
        thread_id, project_id, title, default_provider, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "thread-archived-child",
      "proj-scratch",
      "模块重构方案草稿",
      "antigravity",
      "2026-11-25T03:13:04.000Z",
      "2026-11-25T03:52:52.000Z",
      "2026-11-25T04:00:00.000Z",
      null,
      JSON.stringify({
        modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
        lineage: { parentThreadId: "thread-active", rootThreadId: "thread-active" },
      })
    );
    insertMsg.run(
      "msg-c1",
      "thread-archived-child",
      null,
      "user",
      "2026-11-25T03:13:04.000Z",
      "2026-11-25T03:13:04.000Z",
      JSON.stringify({ text: "帮我整理这份模块重构草稿" })
    );
    insertMsg.run(
      "msg-c2",
      "thread-archived-child",
      null,
      "assistant",
      "2026-11-25T03:14:00.000Z",
      "2026-11-25T03:14:00.000Z",
      JSON.stringify({ text: "建议按数据源拆分为独立模块并补充单元测试。" })
    );

    // 3. Soft-deleted thread (must be ignored)
    src.prepare(
      `INSERT INTO orchestration_v2_projection_threads(
        thread_id, project_id, title, default_provider, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "thread-deleted",
      "proj-real",
      "失败的已删会话",
      "antigravity",
      "2026-11-24T07:03:12.000Z",
      "2026-11-24T07:05:00.000Z",
      null,
      "2026-11-24T07:21:05.000Z",
      JSON.stringify({})
    );
    insertMsg.run(
      "msg-d1",
      "thread-deleted",
      null,
      "user",
      "2026-11-24T07:03:12.000Z",
      "2026-11-24T07:03:12.000Z",
      JSON.stringify({ text: "失败请求" })
    );
  } finally {
    src.close();
  }

  assert.equal(t3Ingest.countT3SessionFiles(), 2);

  const first = t3Ingest.syncT3Sessions();
  assert.equal(first.scannedFiles, 2);
  assert.equal(first.updatedSessions, 2);
  assert.equal(first.skippedFiles, 0);
  assert.equal(first.warnings, 0);

  const activeSession = database.db
    .prepare(
      `SELECT id, tool, project, title, session_target, session_kind, native_thread_id, parent_native_thread_id, message_count
       FROM sessions WHERE id = 't3:thread-active'`
    )
    .get() as Record<string, unknown>;
  assert.equal(activeSession.tool, "t3");
  assert.equal(activeSession.project, "/tmp/work/my-service");
  assert.equal(activeSession.title, "发布前代码变更检查");
  assert.equal(activeSession.session_target, "my-service");
  assert.equal(activeSession.session_kind, "user");
  assert.equal(activeSession.native_thread_id, "thread-active");
  assert.equal(activeSession.parent_native_thread_id, null);
  assert.equal(activeSession.message_count, 3); // user + assistant + tool summary

  const activeMessages = database.db
    .prepare("SELECT role, content, turn_index FROM messages WHERE session_id = 't3:thread-active' ORDER BY seq_in_session ASC")
    .all() as Array<{ role: string; content: string; turn_index: number }>;
  assert.equal(activeMessages.length, 3);
  assert.match(activeMessages[0].content, /\[file: diff\.patch\]/);
  assert.equal(activeMessages[1].role, "assistant");
  assert.equal(activeMessages[2].role, "tool");
  assert.equal(activeMessages[2].content, "Tools: Read, file_search");
  assert.ok(!activeMessages.some((m) => m.content.includes("已被回滚")));

  const usageSummary = database.db
    .prepare("SELECT provider, model, usage_status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, total_tokens FROM session_usage_summary WHERE session_id = 't3:thread-active'")
    .get() as Record<string, unknown>;
  assert.equal(usageSummary.provider, "antigravity");
  assert.equal(usageSummary.model, "gemini-4-neon");
  assert.equal(usageSummary.usage_status, "exact");
  assert.equal(usageSummary.input_tokens, 10000);
  assert.equal(usageSummary.output_tokens, 500);
  assert.equal(usageSummary.cache_read_tokens, 8000);
  assert.equal(usageSummary.reasoning_tokens, 120);
  assert.equal(usageSummary.total_tokens, 10500);

  const archivedChild = database.db
    .prepare("SELECT project, session_kind, parent_native_thread_id FROM sessions WHERE id = 't3:thread-archived-child'")
    .get() as Record<string, unknown>;
  assert.equal(archivedChild.project, null);
  assert.equal(archivedChild.session_kind, "subagent");
  assert.equal(archivedChild.parent_native_thread_id, "thread-active");

  const deletedRow = database.db.prepare("SELECT id FROM sessions WHERE id = 't3:thread-deleted'").get();
  assert.equal(deletedRow, undefined);

  // Second run should skip unchanged threads
  const second = t3Ingest.syncT3Sessions();
  assert.equal(second.scannedFiles, 2);
  assert.equal(second.updatedSessions, 0);
  assert.equal(second.skippedFiles, 2);

  // Soft-deleting an already-synced thread in T3 should remove it on next full sync
  const src2 = new Database(fixturePath);
  try {
    src2.prepare("UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-26T00:00:00.000Z' WHERE thread_id = 'thread-archived-child'").run();
  } finally {
    src2.close();
  }

  const third = t3Ingest.syncT3Sessions();
  assert.equal(third.scannedFiles, 1);
  assert.equal(third.skippedFiles, 1);
  assert.equal(database.db.prepare("SELECT id FROM sessions WHERE id = 't3:thread-archived-child'").get(), undefined);
});
