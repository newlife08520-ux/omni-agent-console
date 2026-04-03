/**
 * 統一 OpenAI 模型決策，避免不同路徑 fallback 不一致。
 * 所有呼叫 OpenAI 的地方應使用 resolveOpenAIModel()。
 */
import { storage } from "./storage";

/** 未設 env／DB 時的主對話模型（與 OpenAI 平台 5.4 系列對齊） */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

/** 設定頁「快捷選模型」內建清單；可與 settings.openai_model_quick_picks_extra 合併 */
export const BUILTIN_OPENAI_MODEL_QUICK_PICKS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5",
] as const;

const OPENAI_MODEL_QUICK_PICKS_EXTRA_KEY = "openai_model_quick_picks_extra";

/** 解析自訂快捷：支援換行或逗號分隔 */
export function parseExtraModelQuickPicks(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  const parts = raw.split(/[\r\n,]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 內建 + DB 自訂，去重且內建順序在前 */
export function getMergedOpenAIModelQuickPicks(): string[] {
  const extra = parseExtraModelQuickPicks(storage.getSetting(OPENAI_MODEL_QUICK_PICKS_EXTRA_KEY));
  const merged: string[] = [...BUILTIN_OPENAI_MODEL_QUICK_PICKS];
  const seen = new Set(merged);
  for (const id of extra) {
    if (!seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
  }
  return merged;
}

export type OpenAIMainModelSource = "env" | "database" | "default";
export type OpenAIRouterModelSource = "env" | "database" | "inherits_main";

export interface OpenAIMainModelResolution {
  effective: string;
  source: OpenAIMainModelSource;
  envVarSet: boolean;
  /** 資料庫 settings.openai_model 原始值（可能為空） */
  storedInDb: string;
}

export interface OpenAIRouterModelResolution {
  effective: string;
  source: OpenAIRouterModelSource;
  envVarSet: boolean;
  storedInDb: string;
}

export function getOpenAIMainModelResolution(): OpenAIMainModelResolution {
  const envVarSet = Boolean(process.env.OPENAI_MODEL?.trim());
  const env = process.env.OPENAI_MODEL?.trim();
  const rawStored = storage.getSetting("openai_model") || "";
  const stored = rawStored.trim();
  if (env) {
    return { effective: env, source: "env", envVarSet: true, storedInDb: rawStored };
  }
  if (stored) {
    return { effective: stored, source: "database", envVarSet: false, storedInDb: rawStored };
  }
  return { effective: DEFAULT_OPENAI_MODEL, source: "default", envVarSet: false, storedInDb: rawStored };
}

export function getOpenAIRouterModelResolution(): OpenAIRouterModelResolution {
  const envVarSet = Boolean(process.env.OPENAI_ROUTER_MODEL?.trim());
  const env = process.env.OPENAI_ROUTER_MODEL?.trim();
  const rawStored = storage.getSetting("openai_router_model") || "";
  const stored = rawStored.trim();
  if (env) {
    return { effective: env, source: "env", envVarSet: true, storedInDb: rawStored };
  }
  if (stored) {
    return { effective: stored, source: "database", envVarSet: false, storedInDb: rawStored };
  }
  const main = getOpenAIMainModelResolution();
  return { effective: main.effective, source: "inherits_main", envVarSet: false, storedInDb: rawStored };
}

/** 供設定頁與除錯：回傳目前實際生效模型與來源（不含金鑰）。 */
export function describeOpenAIModelsForSettings() {
  const main = getOpenAIMainModelResolution();
  const router = getOpenAIRouterModelResolution();
  return {
    defaultMainModel: DEFAULT_OPENAI_MODEL,
    builtInQuickPicks: [...BUILTIN_OPENAI_MODEL_QUICK_PICKS],
    modelQuickPicks: getMergedOpenAIModelQuickPicks(),
    main,
    router,
  };
}

export function resolveOpenAIModel(): string {
  return getOpenAIMainModelResolution().effective;
}

/** Phase 1 Hybrid Router 專用：可獨立設定較小／較快模型；未設定則沿用主模型。 */
export function resolveOpenAIRouterModel(): string {
  return getOpenAIRouterModelResolution().effective;
}
