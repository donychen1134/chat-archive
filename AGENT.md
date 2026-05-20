# Chat Archive

本项目是一个本地优先的 AI CLI 会话归档工具，用于把 Codex、Claude Code、Copilot CLI、Gemini CLI、OpenCode 等工具的本地聊天记录同步到 SQLite，并提供统一的搜索、会话浏览、摘要和用量统计。

## 技术栈

- Backend: Fastify + TypeScript + better-sqlite3
- Frontend: React + Vite + TypeScript
- Database: SQLite，默认路径 `~/.chat-archive/chat-archive.db`
- Search: SQLite FTS5

## 目录结构

- `server/src/db.ts`: 数据库初始化、表结构、索引。
- `server/src/*-ingest.ts`: 各 CLI 的日志解析和同步逻辑。
- `server/src/sync.ts`: 汇总执行所有来源的同步。
- `server/src/sync-manager.ts`: 后台 sync/reindex worker 管理和进度状态。
- `server/src/server.ts`: Fastify API、搜索、会话详情、设置、用量接口。
- `server/src/summary-provider.ts`: rule、Qwen、Friday、Codex、hybrid 摘要 provider。
- `server/src/rule-summary.ts`: 无外部依赖的标题和关键词提取。
- `web/src/App.tsx`: 主前端应用。
- `web/src/styles.css`: 前端样式。

## 数据源

- Codex: `~/.codex/sessions`，可用 `CODEX_SESSIONS_DIR` 覆盖。
- Claude Code: `~/.claude/projects/**/*.jsonl`，排除 `subagents`。
- Copilot CLI: `~/.copilot/session-state/**/events.jsonl`。
- Gemini CLI: `~/.gemini/tmp/**/chats/session-*.json`。
- OpenCode: 本地 OpenCode 会话数据。

所有来源最终写入统一的 `sessions`、`messages`、`message_fts`、`usage_records`、`session_usage_summary` 等表。

## 常用命令

```bash
npm install
npm --prefix server install
npm --prefix web install

npm run dev
npm run build
npm run sync
```

开发服务默认地址：

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8765`

## 关键行为

- 后端启动后默认立即 sync 一次，并按 `AUTO_SYNC_INTERVAL_MS` 定时同步；默认 5 分钟，可用 `AUTO_SYNC_ON_START=false` 禁用启动和定时同步。
- sync 使用 `ingest_state` 的 `source_path + mtime + size` 做增量跳过。
- `/api/reindex` 会触发全量重建。
- `/api/reindex/session` 会重建单个会话。
- 搜索入口是 `/api/sessions`，支持 `scope=all|question|answer` 和工具过滤。
- 摘要 provider 通过 `CHAT_ARCHIVE_SUMMARY_PROVIDER=rule|qwen|friday|codex|hybrid` 控制，默认 `rule`。

## 开发注意事项

- 会话内容可能包含敏感路径、命令和业务上下文，不要提交本地数据库或导出的真实聊天数据。
- 解析器要兼容不同工具日志格式变化，遇到 malformed line 应跳过并记录 warning，不要中断整个 sync。
- 修改 FTS 表结构或 tokenizer 后，需要考虑 reindex。
- 不要随意删除用户已有的本地数据；新增迁移应保持向后兼容。
