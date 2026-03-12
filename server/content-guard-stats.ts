/**
 * Content-guard 命中統計：追蹤哪些規則最常命中、清洗 vs fallback 比例。
 * 若命中率偏高，代表前面生成仍需再修。
 */
import fs from "fs";
import path from "path";
import { getDataDir } from "./data-dir";

export type GuardRuleId =
  | "category_mismatch_sweet"
  | "mode_forbidden_promo"
  | "official_channel_forbidden";

export type GuardOutcome = "cleaned" | "fallback";

interface GuardHit {
  rule: GuardRuleId;
  outcome: GuardOutcome;
  at: string;
}

let inMemoryHits: GuardHit[] = [];
const MAX_IN_MEMORY = 5000;
const STATS_FILE = "content-guard-stats.json";

function getStatsPath(): string {
  return path.join(getDataDir(), STATS_FILE);
}

function loadPersisted(): GuardHit[] {
  try {
    const p = getStatsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const data = JSON.parse(raw) as { hits?: GuardHit[] };
      return Array.isArray(data.hits) ? data.hits : [];
    }
  } catch (_e) {
    // ignore
  }
  return [];
}

function persist(hits: GuardHit[]) {
  try {
    const p = getStatsPath();
    fs.writeFileSync(p, JSON.stringify({ hits, updated_at: new Date().toISOString() }, null, 2), "utf-8");
  } catch (_e) {
    // ignore
  }
}

/**
 * 記錄一次 guard 命中。outcome = 使用清洗後文案；fallback = 使用預設句。
 */
export function recordGuardHit(rule: GuardRuleId, outcome: GuardOutcome): void {
  const hit: GuardHit = { rule, outcome, at: new Date().toISOString() };
  inMemoryHits.push(hit);
  if (inMemoryHits.length > MAX_IN_MEMORY) {
    inMemoryHits = inMemoryHits.slice(-MAX_IN_MEMORY);
  }
  const all = loadPersisted().concat([hit]).slice(-MAX_IN_MEMORY);
  persist(all);
}

/**
 * 取得目前統計（先合併持久化與記憶體，再彙總）。
 */
export function getGuardStats(): {
  totalHits: number;
  byRule: Record<GuardRuleId, { total: number; cleaned: number; fallback: number }>;
  byOutcome: { cleaned: number; fallback: number };
  samplePeriod: string;
} {
  const persisted = loadPersisted();
  const combined = [...persisted];
  const byRule: Record<GuardRuleId, { total: number; cleaned: number; fallback: number }> = {
    category_mismatch_sweet: { total: 0, cleaned: 0, fallback: 0 },
    mode_forbidden_promo: { total: 0, cleaned: 0, fallback: 0 },
    official_channel_forbidden: { total: 0, cleaned: 0, fallback: 0 },
  };
  let cleaned = 0;
  let fallback = 0;
  for (const h of combined) {
    byRule[h.rule].total += 1;
    if (h.outcome === "cleaned") {
      byRule[h.rule].cleaned += 1;
      cleaned += 1;
    } else {
      byRule[h.rule].fallback += 1;
      fallback += 1;
    }
  }
  const minAt = combined.length ? combined.reduce((a, b) => (a.at < b.at ? a : b)).at : "";
  const maxAt = combined.length ? combined.reduce((a, b) => (a.at > b.at ? a : b)).at : "";
  return {
    totalHits: combined.length,
    byRule,
    byOutcome: { cleaned, fallback },
    samplePeriod: minAt && maxAt ? `${minAt.slice(0, 10)} ~ ${maxAt.slice(0, 10)}` : "",
  };
}

/** 重置記憶體與持久化（測試用） */
export function resetGuardStats(): void {
  inMemoryHits = [];
  try {
    if (fs.existsSync(getStatsPath())) fs.unlinkSync(getStatsPath());
  } catch (_e) {
    // ignore
  }
}
