/**
 * 統一 AI 模型／供應商決策（主對話）。
 * Hybrid Router 仍僅使用 OpenAI，見 resolveOpenAIRouterModel。
 * 舊程式碼可繼續使用 resolveOpenAIModel()（回傳目前供應商下的 model id 字串）。
 */
import { storage } from "./storage";

export type AiProvider = "openai" | "anthropic" | "google";

export interface ResolvedModel {
  provider: AiProvider;
  model: string;
}

/** OpenAI 模型 id 後備（對應預設字串 openai:gpt-4o） */
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** 設定頁「快捷選模型」內建清單（僅 OpenAI id）；可與 settings.openai_model_quick_picks_extra 合併 */
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

/** 未經 OPENAI_MODEL 覆寫邏輯處理的原始設定字串（env → ai_model → openai_model → 預設） */
function rawAiModelString(): string {
  const envAi = process.env.AI_MODEL?.trim();
  if (envAi) return envAi;
  const dbAi = storage.getSetting("ai_model")?.trim();
  if (dbAi) return dbAi;
  const legacyOpenaiModel = storage.getSetting("openai_model")?.trim();
  if (legacyOpenaiModel) {
    if (
      legacyOpenaiModel.startsWith("anthropic:") ||
      legacyOpenaiModel.startsWith("openai:") ||
      legacyOpenaiModel.startsWith("google:")
    ) {
      return legacyOpenaiModel;
    }
    return `openai:${legacyOpenaiModel}`;
  }
  return "openai:gpt-4o";
}

/**
 * 解析目前主對話供應商與模型 id。
 * 環境變數 AI_MODEL：`openai:gpt-4o`、`anthropic:claude-sonnet-4-5`、`google:gemini-…`；無前綴視為 openai。
 */
export function resolveModel(): ResolvedModel {
  const raw = rawAiModelString();
  if (raw.startsWith("google:")) {
    return { provider: "google", model: raw.slice("google:".length) };
  }
  if (raw.startsWith("anthropic:")) {
    return { provider: "anthropic", model: raw.slice("anthropic:".length) };
  }
  const legacyOpenai = process.env.OPENAI_MODEL?.trim();
  if (legacyOpenai && !raw.includes(":")) {
    return { provider: "openai", model: legacyOpenai };
  }
  const model = raw.startsWith("openai:") ? raw.slice("openai:".length) : raw;
  return { provider: "openai", model };
}

/**
 * 品牌級覆寫（phase1_agent_ops_json.ai_model_override）。
 * 格式同 AI_MODEL：`openai:gpt-4o`、`anthropic:claude-sonnet-4-5`；無前綴視為 OpenAI model id。
 */
export function resolveModelWithBrandOverride(modelOverride?: string | null): ResolvedModel {
  const t = modelOverride?.trim();
  if (t) {
    if (t.startsWith("google:")) return { provider: "google", model: t.slice("google:".length) };
    if (t.startsWith("anthropic:")) return { provider: "anthropic", model: t.slice("anthropic:".length) };
    if (t.startsWith("openai:")) return { provider: "openai", model: t.slice("openai:".length) };
    return { provider: "openai", model: t };
  }
  return resolveModel();
}

export type OpenAIMainModelSource = "env" | "database" | "default";
export type OpenAIRouterModelSource = "env" | "database" | "inherits_main";

export interface OpenAIMainModelResolution {
  effective: string;
  source: OpenAIMainModelSource;
  envVarSet: boolean;
  /** 資料庫 ai_model 或 openai_model 原始值（可能為空） */
  storedInDb: string;
}

export interface OpenAIRouterModelResolution {
  effective: string;
  source: OpenAIRouterModelSource;
  envVarSet: boolean;
  storedInDb: string;
}

export function getOpenAIMainModelResolution(): OpenAIMainModelResolution {
  const rm = resolveModel();
  const aiModelEnv = process.env.AI_MODEL?.trim();
  const openaiEnv = process.env.OPENAI_MODEL?.trim();
  const rawStoredAi = storage.getSetting("ai_model") || "";
  const rawStoredLegacy = storage.getSetting("openai_model") || "";
  const storedInDb = rawStoredAi.trim() || rawStoredLegacy.trim();
  const envVarSet = Boolean(aiModelEnv || openaiEnv);

  let source: OpenAIMainModelSource = "default";
  if (aiModelEnv || openaiEnv) source = "env";
  else if (storedInDb) source = "database";

  return {
    effective: rm.model,
    source,
    envVarSet,
    storedInDb: rawStoredAi || rawStoredLegacy,
  };
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

/** 與下拉儲存格式一致，供頂部橫幅單行顯示 */
export function resolvedModelToPrefixedString(rm: ResolvedModel): string {
  const prefix = rm.provider === "anthropic" ? "anthropic" : rm.provider === "google" ? "google" : "openai";
  return `${prefix}:${rm.model}`;
}

/** 供設定頁與除錯：回傳目前實際生效模型與來源（不含金鑰）。 */
export function describeOpenAIModelsForSettings() {
  const main = getOpenAIMainModelResolution();
  const router = getOpenAIRouterModelResolution();
  const resolved = resolveModel();
  const envAi = process.env.AI_MODEL?.trim() || "";
  const envOpenai = process.env.OPENAI_MODEL?.trim() || "";
  const dbAiRow = (storage.getSetting("ai_model") || "").trim();
  return {
    defaultMainModel: DEFAULT_OPENAI_MODEL,
    builtInQuickPicks: [...BUILTIN_OPENAI_MODEL_QUICK_PICKS],
    modelQuickPicks: getMergedOpenAIModelQuickPicks(),
    main,
    router,
    provider: resolved.provider,
    aiModelEnvSet: Boolean(envAi),
    /** 頂部應顯示此字串（與 ai_model 下拉格式相同） */
    effectiveMainFull: resolvedModelToPrefixedString(resolved),
    /** 資料庫 ai_model 欄位（使用者以為的選擇）；若與 effective 不同且 source 為 env，代表被環境變數蓋掉 */
    databaseAiModelRow: dbAiRow,
    envAiModelPreview: envAi || null,
    envOpenaiModelPreview: envOpenai || null,
    /** 主對話是否由環境變數決定（儲存 ai_model 也不會改實際對話模型） */
    mainConversationLockedByEnv: main.source === "env",
  };
}

/** 向下相容：回傳目前解析到的「模型 id」字串（OpenAI 或 Anthropic 皆為官方 model 名）。 */
export function resolveOpenAIModel(): string {
  return resolveModel().model;
}

/** Phase 1 Hybrid Router 專用：可獨立設定較小／較快模型；未設定則沿用主模型（仍為 OpenAI 用 id）。 */
export function resolveOpenAIRouterModel(): string {
  return getOpenAIRouterModelResolution().effective;
}
