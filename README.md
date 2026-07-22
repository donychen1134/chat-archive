# Chat Archive

A local-first chat archive for AI coding CLIs (Codex, Claude Code, Copilot CLI, Gemini CLI), with unified sync, search, and session browsing.

## Why this project

CLI chat logs often contain high-value troubleshooting context and design decisions, but terminal history is hard to retain and review. This project focuses on:

- Persistent local archive of chat sessions
- Better session browsing (collapse/expand by turn, pagination, filtering)
- Session-level metadata (title/summary/keywords/time)
- Full-text and scoped search

## Supported CLIs

- Codex (`~/.codex/sessions`)
- Claude Code (`~/.claude/projects/**/*.jsonl`, excluding `subagents`)
- Copilot CLI (`~/.copilot/session-state/**/events.jsonl`)
- Gemini CLI (`~/.gemini/tmp/**/chats/session-*.json`)

All data is stored locally in SQLite.

## Features

- Incremental sync and full reindex
- SQLite + FTS5 full-text search
- Search scopes:
  - `question` (user messages)
  - `answer` (assistant messages)
  - `all` (full text)
- Space-separated search terms use session-level AND semantics, so terms may match different messages or metadata fields in one session.
- Session list with CLI badges and pagination
- Turn-based detail view with collapse/expand
- Optional hide/show system/tool messages
- Adjacent duplicate message dedup
- Markdown code fence rendering with syntax highlighting
- Topic extraction providers:
  - `rule` (default, no external dependency)
  - `qwen`
  - `friday`
  - `codex`
  - `hybrid`

## Tech Stack

- Backend: Fastify + TypeScript + better-sqlite3
- Frontend: React + Vite + TypeScript

## Project Structure

- `server/`: API, storage, sync pipeline, summary providers
- `web/`: UI application

## Quick Start

### 1) Install dependencies

```bash
npm install
npm --prefix server install
npm --prefix web install
```

### 2) Start dev servers

```bash
npm run dev
```

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8765`

### 3) Build

```bash
npm run build
npm test
```

## Common Commands

```bash
# Trigger one sync run from CLI (backend script)
npm run sync

# Backend only (includes startup auto-sync unless disabled)
npm run ui

# API checks
curl http://127.0.0.1:8765/api/health
curl http://127.0.0.1:8765/api/sync/status

# Full rebuild
curl -X POST http://127.0.0.1:8765/api/reindex

# Summary provider settings / connectivity test
curl http://127.0.0.1:8765/api/summary/settings
curl -X POST http://127.0.0.1:8765/api/summary/test
```

## Environment Variables

- `CODEX_SESSIONS_DIR`
- `CLAUDE_PROJECTS_DIR`
- `COPILOT_SESSIONS_DIR`
- `GEMINI_SESSIONS_DIR`
- `CHAT_ARCHIVE_HOME` (default: `~/.chat-archive`)
- `PORT` (default: `8765`)
- `AUTO_SYNC_ON_START=false`
- `AUTO_SYNC_INTERVAL_MS` (default: `300000`; set `0` to disable scheduled sync)
- `AUTO_SYNC_INTERVAL_SECONDS` (used only when `AUTO_SYNC_INTERVAL_MS` is not set)
- `CODEX_WATCH_ENABLED=false` (disable Codex session file watcher)
- `CODEX_WATCH_DEBOUNCE_MS` (default: `3000`)
- `CODEX_WATCH_RETRY_MS` (default: `5000`)

Summary-related:

- `CHAT_ARCHIVE_SUMMARY_PROVIDER` = `rule|qwen|friday|hybrid|codex` (default: `rule`)
- `CHAT_ARCHIVE_SUMMARY_MODEL` (default: `gpt-5-codex`)
- `CHAT_ARCHIVE_SUMMARY_TIMEOUT_MS` (default: `30000`)
- `CHAT_ARCHIVE_CODEX_LIMIT_PER_RUN` (default: `8`)
- `CHAT_ARCHIVE_REMOTE_SUMMARY_MAX_AGE_DAYS` (default: `5`, based on the session's latest activity)
- `CHAT_ARCHIVE_QWEN_API_KEY` (or `DASHSCOPE_API_KEY`)
- `CHAT_ARCHIVE_QWEN_BASE_URL` (default: `https://dashscope.aliyuncs.com/compatible-mode/v1`)
- `CHAT_ARCHIVE_FRIDAY_APP_ID` (or local app_config `friday.app_id`)
- `CHAT_ARCHIVE_FRIDAY_BASE_URL` (default: `https://aigc.sankuai.com/v1/openai/native`)

## Security Notes

- Do not commit `.env*`, local DB files, or exported chat data.
- Session contents may include internal repo paths, commands, and business context.
- If you plan to open-source, sanitize any sample data before sharing.

## Current Status

This is an MVP focused on local usability and extensible ingesters/providers. Contributions and issue reports are welcome.
