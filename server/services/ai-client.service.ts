import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { resolveModel } from "../openai-model";
import { storage } from "../storage";

/** system 僅字串；user/assistant 可為 Claude 多模態／tool_use／tool_result 區塊 */
export type AiMessage =
  | { role: "system"; content: string }
  | { role: "user" | "assistant"; content: string | ContentBlockParam[] };

export interface AiCallOptions {
  messages: AiMessage[];
  tools?: object[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiCallResult {
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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

export async function callAiModel(options: AiCallOptions): Promise<AiCallResult> {
  const { provider, model } = resolveModel();
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
