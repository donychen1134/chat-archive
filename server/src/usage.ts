import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import type { UsageInput, UsageStatus } from "./types.js";

type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_tokens: number;
  total_tokens: number;
  cost: number | null;
};

export type UsageContribution = UsageInput;

function safeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function safeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function computeTotal(record: UsageInput): number {
  if (record.total_tokens > 0) return record.total_tokens;
  return record.input_tokens + record.output_tokens + record.reasoning_tokens + record.tool_tokens;
}

function usageStatusForRecords(records: UsageInput[]): UsageStatus {
  if (records.length === 0) return "unavailable";
  return records.every((record) => record.source_type === "native_exact") ? "exact" : "partial";
}

function blankTotals(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_tokens: 0,
    total_tokens: 0,
    cost: null,
  };
}

function addTotals(target: UsageTotals, source: UsageTotals): UsageTotals {
  return {
    input_tokens: target.input_tokens + source.input_tokens,
    output_tokens: target.output_tokens + source.output_tokens,
    reasoning_tokens: target.reasoning_tokens + source.reasoning_tokens,
    cache_read_tokens: target.cache_read_tokens + source.cache_read_tokens,
    cache_write_tokens: target.cache_write_tokens + source.cache_write_tokens,
    tool_tokens: target.tool_tokens + source.tool_tokens,
    total_tokens: target.total_tokens + source.total_tokens,
    cost:
      target.cost === null && source.cost === null
        ? null
        : (target.cost ?? 0) + (source.cost ?? 0),
  };
}

function totalsFromRecord(record: UsageInput): UsageTotals {
  return {
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    reasoning_tokens: record.reasoning_tokens,
    cache_read_tokens: record.cache_read_tokens,
    cache_write_tokens: record.cache_write_tokens,
    tool_tokens: record.tool_tokens,
    total_tokens: record.total_tokens,
    cost: record.cost,
  };
}

function diffTotals(next: UsageTotals, prev: UsageTotals): UsageTotals {
  const costDiff =
    next.cost === null
      ? null
      : Math.max(0, (next.cost ?? 0) - (prev.cost ?? 0));
  return {
    input_tokens: Math.max(0, next.input_tokens - prev.input_tokens),
    output_tokens: Math.max(0, next.output_tokens - prev.output_tokens),
    reasoning_tokens: Math.max(0, next.reasoning_tokens - prev.reasoning_tokens),
    cache_read_tokens: Math.max(0, next.cache_read_tokens - prev.cache_read_tokens),
    cache_write_tokens: Math.max(0, next.cache_write_tokens - prev.cache_write_tokens),
    tool_tokens: Math.max(0, next.tool_tokens - prev.tool_tokens),
    total_tokens: Math.max(0, next.total_tokens - prev.total_tokens),
    cost: costDiff,
  };
}

function hasNonZeroTotals(totals: UsageTotals): boolean {
  return (
    totals.input_tokens > 0 ||
    totals.output_tokens > 0 ||
    totals.reasoning_tokens > 0 ||
    totals.cache_read_tokens > 0 ||
    totals.cache_write_tokens > 0 ||
    totals.tool_tokens > 0 ||
    totals.total_tokens > 0 ||
    (totals.cost ?? 0) > 0
  );
}

export function normalizeUsageRecord(record: UsageInput): UsageInput {
  const normalized: UsageInput = {
    ...record,
    project: record.project?.trim() || null,
    provider: record.provider?.trim() || null,
    model: record.model?.trim() || null,
    usage_time: record.usage_time || new Date(0).toISOString(),
    input_tokens: Math.max(0, Math.floor(safeNumber(record.input_tokens))),
    output_tokens: Math.max(0, Math.floor(safeNumber(record.output_tokens))),
    reasoning_tokens: Math.max(0, Math.floor(safeNumber(record.reasoning_tokens))),
    cache_read_tokens: Math.max(0, Math.floor(safeNumber(record.cache_read_tokens))),
    cache_write_tokens: Math.max(0, Math.floor(safeNumber(record.cache_write_tokens))),
    tool_tokens: Math.max(0, Math.floor(safeNumber(record.tool_tokens))),
    total_tokens: Math.max(0, Math.floor(safeNumber(record.total_tokens))),
    cost: safeNullableNumber(record.cost),
    raw_ref: record.raw_ref.trim(),
  };
  normalized.total_tokens = computeTotal(normalized);
  return normalized;
}

export function computeUsageContributions(rawRecords: UsageInput[]): UsageContribution[] {
  const normalized = rawRecords
    .map(normalizeUsageRecord)
    .filter((record) => record.raw_ref.length > 0 && record.usage_time.length > 0);
  const bySession = new Map<string, UsageInput[]>();
  for (const record of normalized) {
    const items = bySession.get(record.session_id) ?? [];
    items.push(record);
    bySession.set(record.session_id, items);
  }

  const contributions: UsageContribution[] = [];
  for (const records of bySession.values()) {
    const cumulativeRecords = records.filter(
      (record) => record.usage_semantics === "snapshot" || record.usage_semantics === "session_total"
    );
    const hasSessionTotal = records.some((record) => record.usage_semantics === "session_total");
    const deltaRecords = records.filter((record) => record.usage_semantics === "delta");
    if (!hasSessionTotal) {
      contributions.push(...deltaRecords);
    }
    if (cumulativeRecords.length === 0) continue;

    const grouped = new Map<string, { base: UsageInput; totals: UsageTotals }>();
    for (const record of cumulativeRecords) {
      const existing = grouped.get(record.usage_time);
      if (!existing) {
        grouped.set(record.usage_time, {
          base: record,
          totals: totalsFromRecord(record),
        });
        continue;
      }
      existing.totals = addTotals(existing.totals, totalsFromRecord(record));
    }

    const ordered = Array.from(grouped.values()).sort((a, b) => a.base.usage_time.localeCompare(b.base.usage_time));
    let previous = blankTotals();
    for (const item of ordered) {
      const delta = diffTotals(item.totals, previous);
      previous = item.totals;
      if (!hasNonZeroTotals(delta)) continue;
      contributions.push({
        ...item.base,
        usage_semantics: "delta",
        input_tokens: delta.input_tokens,
        output_tokens: delta.output_tokens,
        reasoning_tokens: delta.reasoning_tokens,
        cache_read_tokens: delta.cache_read_tokens,
        cache_write_tokens: delta.cache_write_tokens,
        tool_tokens: delta.tool_tokens,
        total_tokens: delta.total_tokens,
        cost: delta.cost,
        raw_ref: `${item.base.raw_ref}:delta`,
      });
    }
  }

  contributions.sort((a, b) => {
    const timeCmp = a.usage_time.localeCompare(b.usage_time);
    if (timeCmp !== 0) return timeCmp;
    return a.raw_ref.localeCompare(b.raw_ref);
  });
  return contributions;
}

export function replaceSessionUsage(sessionId: string, records: UsageInput[]): void {
  const deleteRecords = db.prepare("DELETE FROM usage_records WHERE session_id = ?");
  const deleteSummary = db.prepare("DELETE FROM session_usage_summary WHERE session_id = ?");
  const insertRecord = db.prepare(`
    INSERT INTO usage_records(
      id, session_id, tool, project, provider, model, record_type, source_type, usage_semantics, usage_time,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, tool_tokens,
      total_tokens, cost, raw_ref, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSummary = db.prepare(`
    INSERT INTO session_usage_summary(
      session_id, tool, project, provider, model, usage_status, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, tool_tokens, total_tokens, cost, record_count, last_usage_time,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rawRecords: UsageInput[]) => {
    deleteRecords.run(sessionId);
    deleteSummary.run(sessionId);

    const normalized = rawRecords
      .map(normalizeUsageRecord)
      .filter((record) => record.raw_ref.length > 0 && record.usage_time.length > 0);
    const now = nowIso();

    if (normalized.length === 0) {
      return;
    }

    for (const record of normalized) {
      const id = crypto
        .createHash("sha1")
        .update(
          [
            record.session_id,
            record.raw_ref,
            record.usage_time,
            record.record_type,
            record.provider ?? "",
            record.model ?? "",
            record.usage_semantics,
          ].join("|")
        )
        .digest("hex");
      insertRecord.run(
        id,
        record.session_id,
        record.tool,
        record.project,
        record.provider,
        record.model,
        record.record_type,
        record.source_type,
        record.usage_semantics,
        record.usage_time,
        record.input_tokens,
        record.output_tokens,
        record.reasoning_tokens,
        record.cache_read_tokens,
        record.cache_write_tokens,
        record.tool_tokens,
        record.total_tokens,
        record.cost,
        record.raw_ref,
        now,
        now
      );
    }

    const contributions = computeUsageContributions(normalized);
    if (contributions.length === 0) {
      return;
    }

    const primary = normalized[normalized.length - 1] ?? normalized[0];
    const summary = contributions.reduce<UsageTotals>((acc, record) => addTotals(acc, totalsFromRecord(record)), blankTotals());
    const lastUsageTime = contributions.reduce(
      (max, record) => (record.usage_time > max ? record.usage_time : max),
      contributions[0].usage_time
    );

    insertSummary.run(
      sessionId,
      primary.tool,
      primary.project,
      primary.provider,
      primary.model,
      usageStatusForRecords(normalized),
      summary.input_tokens,
      summary.output_tokens,
      summary.reasoning_tokens,
      summary.cache_read_tokens,
      summary.cache_write_tokens,
      summary.tool_tokens,
      summary.total_tokens,
      summary.cost,
      contributions.length,
      lastUsageTime,
      now,
      now
    );
  });

  tx(records);
}
