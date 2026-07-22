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
    "帮我排查 scheduler 超时问题",
  ].join("\n");
  assert.equal(cleaning.stripBoilerplateContent(raw), "帮我排查 scheduler 超时问题");
  assert.equal(rules.buildTitleAndSummary([message(raw)]).title, "排查 scheduler 超时问题");
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
