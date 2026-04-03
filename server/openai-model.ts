/**
 * 統一 OpenAI 模型決策，避免不同路徑 fallback 不一致。
 * 所有呼叫 OpenAI 的地方應使用 resolveOpenAIModel()。
 */
import { storage } from "./storage";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

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
