import OpenAI from "openai";
import type { ResolvedModel } from "./openai-model";

/** Gemini API 的 OpenAI Chat Completions 相容端點（僅供需 OpenAI SDK 形狀的呼叫，例如 Hybrid Router） */
export const GEMINI_OPENAI_COMPAT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/" as const;

/**
 * 依解析後的供應商建立 `OpenAI` SDK 實例。
 * - google：走 Gemini 相容 API，需 gemini_api_key
 * - openai：預設 api.openai.com
 * - anthropic：此 SDK 無法直連，回傳 null（呼叫端應略過或另接 Anthropic）
 */
export function createChatCompletionsOpenAIClient(
  rm: ResolvedModel,
  keys: { openaiApiKey: string | null | undefined; geminiApiKey: string | null | undefined }
): OpenAI | null {
  if (rm.provider === "google") {
    const k = keys.geminiApiKey?.trim();
    if (!k) return null;
    return new OpenAI({ apiKey: k, baseURL: GEMINI_OPENAI_COMPAT_BASE_URL });
  }
  if (rm.provider === "openai") {
    const k = keys.openaiApiKey?.trim();
    if (!k) return null;
    return new OpenAI({ apiKey: k });
  }
  return null;
}
