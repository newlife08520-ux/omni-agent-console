/**
 * 統一 OpenAI 模型決策，避免不同路徑 fallback 不一致。
 * 所有呼叫 OpenAI 的地方應使用 resolveOpenAIModel()。
 */
import { storage } from "./storage";

export function resolveOpenAIModel(): string {
  const env = process.env.OPENAI_MODEL?.trim();
  if (env) return env;
  const setting = storage.getSetting("openai_model")?.trim();
  if (setting) return setting;
  return "gpt-4o-mini";
}

/** Phase 1 Hybrid Router 專用：可獨立設定較小／較快模型；未設定則沿用主模型。 */
export function resolveOpenAIRouterModel(): string {
  const env = process.env.OPENAI_ROUTER_MODEL?.trim();
  if (env) return env;
  const setting = storage.getSetting("openai_router_model")?.trim();
  if (setting) return setting;
  return resolveOpenAIModel();
}
