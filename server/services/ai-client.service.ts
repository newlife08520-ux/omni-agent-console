import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { resolveMainConversationModel } from "../openai-model";
import { storage } from "../storage";

/** system 僅字串；user/assistant 可為 Claude 多模態／tool_use／tool_result 區塊 */
export type AiMessage =
  | { role: "system"; content: string }
  | {
      role: "user" | "assistant";
      content: string | ContentBlockParam[];
      /** Google Gemini 3.x：含 functionCall 的 model 回合須保留 API 回傳的 parts（含 thoughtSignature），不可只用 tool_use 重建 */
      geminiModelParts?: Part[];
    };

export interface AiCallOptions {
  messages: AiMessage[];
  tools?: object[];
  maxTokens?: number;
  temperature?: number;
  /** 品牌級覆寫（Phase 1 enabled 時由 ai-reply 傳入）；格式 openai:…／anthropic:…／google:… 或純 OpenAI id */
  modelOverride?: string;
}

export interface AiCallResult {
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Google：上一輪 model 的原始 parts，供下一輪 tool result 前原樣帶回（thought_signature） */
  geminiModelParts?: Part[];
}

function openAiToolToClaudeSchema(t: Record<string, unknown>): Anthropic.Tool {
  const fn = (t.function as Record<string, unknown> | undefined) ?? t;
  const name = String(fn.name ?? "tool");
  const description = (fn.description as string | undefined) ?? "";
  const parameters =
    (fn.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} };
  return {
    name,
    description,
    input_schema: parameters as Anthropic.Tool["input_schema"],
  };
}

function openAiToolToGeminiFunctionDeclaration(t: Record<string, unknown>): FunctionDeclaration {
  const fn = (t.function as Record<string, unknown> | undefined) ?? t;
  const name = String(fn.name ?? "tool");
  const description = typeof fn.description === "string" ? fn.description : undefined;
  const parameters = fn.parameters;
  const decl: FunctionDeclaration = { name, description };
  if (parameters && typeof parameters === "object") {
    decl.parameters = parameters as FunctionDeclaration["parameters"];
  }
  return decl;
}

function parseToolResultForGeminiResponse(raw: string): object {
  try {
    const j = JSON.parse(raw) as unknown;
    if (typeof j === "object" && j !== null && !Array.isArray(j)) return j as object;
    return { result: j };
  } catch {
    return { result: raw };
  }
}

function claudeStyleMessagesToGeminiContents(messages: AiMessage[]): {
  systemInstruction: string;
  contents: Content[];
} {
  let systemInstruction = "";
  const contents: Content[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content !== "string") {
        throw new Error("Gemini：system 僅支援字串");
      }
      systemInstruction = systemInstruction ? `${systemInstruction}\n\n${m.content}` : m.content;
      continue;
    }

    if (m.role === "user") {
      const c = m.content;
      if (typeof c === "string") {
        contents.push({ role: "user", parts: [{ text: c }] });
        continue;
      }
      if (!Array.isArray(c)) throw new Error("Gemini：無效的 user 訊息");

      const textBits: string[] = [];
      const toolResultStrings: string[] = [];
      for (const b of c as ContentBlockParam[]) {
        if (b.type === "text") textBits.push(b.text);
        else if (b.type === "tool_result") {
          toolResultStrings.push(typeof b.content === "string" ? b.content : String(b.content));
        }
      }

      const parts: Part[] = [];
      for (const tb of textBits) {
        if (tb.trim()) parts.push({ text: tb });
      }

      if (toolResultStrings.length > 0) {
        const prev = contents[contents.length - 1];
        if (!prev || prev.role !== "model") {
          throw new Error("Gemini：tool_result 前必須為含 functionCall 的 model 回合");
        }
        const callParts = prev.parts.filter((p) => Boolean((p as { functionCall?: unknown }).functionCall));
        if (callParts.length !== toolResultStrings.length) {
          throw new Error(
            `Gemini：tool_result 數量 (${toolResultStrings.length}) 與上一輪 functionCall (${callParts.length}) 不一致`
          );
        }
        for (let i = 0; i < toolResultStrings.length; i++) {
          const fc = (callParts[i] as { functionCall: { name: string } }).functionCall;
          parts.push({
            functionResponse: {
              name: fc.name,
              response: parseToolResultForGeminiResponse(toolResultStrings[i]),
            },
          });
        }
      }

      if (parts.length === 0) continue;
      contents.push({ role: "user", parts });
      continue;
    }

    if (m.role === "assistant") {
      const gp = (m as { geminiModelParts?: Part[] }).geminiModelParts;
      if (gp && gp.length > 0) {
        let cloned: Part[];
        try {
          cloned = structuredClone(gp) as Part[];
        } catch {
          cloned = JSON.parse(JSON.stringify(gp)) as Part[];
        }
        contents.push({ role: "model", parts: cloned });
        continue;
      }
      const c = m.content;
      if (typeof c === "string") {
        if (c.trim()) contents.push({ role: "model", parts: [{ text: c }] });
        continue;
      }
      if (!Array.isArray(c)) throw new Error("Gemini：無效的 assistant 訊息");
      const parts: Part[] = [];
      for (const b of c as ContentBlockParam[]) {
        if (b.type === "text" && b.text?.trim()) {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          const inputObj =
            b.input && typeof b.input === "object" && !Array.isArray(b.input)
              ? (b.input as object)
              : {};
          parts.push({
            functionCall: {
              name: b.name,
              args: inputObj,
            },
          });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
    }
  }

  return { systemInstruction, contents };
}

export async function callAiModel(options: AiCallOptions): Promise<AiCallResult> {
  const { provider, model } = resolveMainConversationModel(options.modelOverride);
  const { messages, tools, maxTokens = 1500, temperature = 0.85 } = options;

  if (provider === "anthropic") {
    const apiKey = storage.getSetting("anthropic_api_key")?.trim();
    if (!apiKey) throw new Error("Anthropic API key 未設定，請在後台設定 anthropic_api_key");

    const client = new Anthropic({ apiKey });
    const systemRow = messages.find((m) => m.role === "system");
    const systemMsg = systemRow && typeof systemRow.content === "string" ? systemRow.content : "";
    const chatMsgs: MessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const role = m.role as "user" | "assistant";
        const c = m.content;
        if (typeof c === "string") return { role, content: c };
        return { role, content: c as ContentBlockParam[] };
      });

    const claudeTools =
      tools?.length ? tools.map((t) => openAiToolToClaudeSchema(t as Record<string, unknown>)) : undefined;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemMsg || undefined,
      messages: chatMsgs,
      ...(claudeTools?.length ? { tools: claudeTools } : {}),
    });

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolUses = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      }));

    return {
      content: textContent,
      tool_calls: toolUses.length > 0 ? toolUses : undefined,
      provider: "anthropic",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  if (provider === "google") {
    const apiKey = storage.getSetting("gemini_api_key")?.trim();
    if (!apiKey) throw new Error("Gemini API key 未設定，請在後台設定 gemini_api_key");

    const { systemInstruction, contents } = claudeStyleMessagesToGeminiContents(messages);
    if (contents.length === 0) {
      throw new Error("Gemini：對話內容為空");
    }

    const funcDecls = tools?.length
      ? tools.map((t) => openAiToolToGeminiFunctionDeclaration(t as Record<string, unknown>))
      : undefined;

    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemInstruction || undefined,
      tools: funcDecls?.length ? [{ functionDeclarations: funcDecls }] : undefined,
      toolConfig: funcDecls?.length
        ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
        : undefined,
    });

    const result = await genModel.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    });

    const response = result.response;
    if (response.promptFeedback?.blockReason) {
      throw new Error(`Gemini 遭安全策略阻擋：${response.promptFeedback.blockReason}`);
    }

    let fcs: ReturnType<typeof response.functionCalls> | undefined;
    try {
      fcs = response.functionCalls();
    } catch {
      fcs = undefined;
    }
    let textContent = "";
    try {
      textContent = response.text();
    } catch {
      textContent = "";
    }

    const tool_calls =
      fcs && fcs.length > 0
        ? fcs.map((fc, i) => ({
            id: `gemini_${fc.name}_${i}_${randomUUID().slice(0, 8)}`,
            name: fc.name,
            arguments: JSON.stringify(
              fc.args && typeof fc.args === "object" && fc.args !== null ? fc.args : {}
            ),
          }))
        : undefined;

    const rawParts = response.candidates?.[0]?.content?.parts;
    let geminiModelParts: Part[] | undefined;
    if (Array.isArray(rawParts) && rawParts.length > 0) {
      try {
        geminiModelParts = structuredClone(rawParts) as Part[];
      } catch {
        geminiModelParts = JSON.parse(JSON.stringify(rawParts)) as Part[];
      }
    }

    const usage = response.usageMetadata;
    return {
      content: textContent,
      tool_calls,
      provider: "google",
      model,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      geminiModelParts,
    };
  }

  const apiKey = storage.getSetting("openai_api_key")?.trim();
  if (!apiKey) throw new Error("OpenAI API key 未設定");

  for (const m of messages) {
    if (typeof (m as AiMessage).content !== "string") {
      throw new Error("OpenAI 路徑僅支援字串 content");
    }
  }
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(tools?.length ? { tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] } : {}),
    max_completion_tokens: maxTokens,
    temperature,
  });

  const msg = completion.choices[0]?.message;
  const toolCalls = msg?.tool_calls
    ?.filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
  return {
    content: typeof msg?.content === "string" ? msg.content : "",
    tool_calls: toolCalls?.length ? toolCalls : undefined,
    provider: "openai",
    model,
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}
