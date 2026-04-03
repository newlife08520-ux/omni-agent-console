import type { Express } from "express";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { storage } from "../storage";
import { authMiddleware } from "../middlewares/auth.middleware";
import { sandboxUpload, uploadDir, fixMulterFilename } from "../middlewares/upload.middleware";
import {
  detectHighRisk,
  getEnrichedSystemPrompt,
  getOpenAIModel,
} from "../services/ai-reply.service";
import { classifyMessageForSafeAfterSale } from "../safe-after-sale-classifier";
import { resolveConversationState } from "../conversation-state-resolver";
import { buildReplyPlan } from "../reply-plan-builder";
import { orderLookupTools, humanHandoffTools, imageTools } from "../openai-tools";
import { createToolExecutor } from "../services/tool-executor.service";

export function registerSandboxRoutes(
  app: Express,
  ctx: { toolExecutor: ReturnType<typeof createToolExecutor> }
): void {
  const { toolExecutor } = ctx;
  app.get("/api/sandbox/prompt-preview", authMiddleware, async (req, res) => {
    try {
      const brandId = req.query.brand_id ? parseInt(req.query.brand_id as string) : undefined;
      const testMessage = (req.query.message as string)?.trim() || undefined;
      const globalPrompt = storage.getSetting("system_prompt") || "";
      const brand = brandId ? storage.getBrand(brandId) : undefined;
      const brandPrompt = brand?.system_prompt || "";
      const fullPrompt = await getEnrichedSystemPrompt(brandId);
      const knowledgeFiles = storage.getKnowledgeFiles(brandId);
      const marketingRules = storage.getMarketingRules(brandId);
      const imageAssets = storage.getImageAssets(brandId);
      const channels = brandId ? storage.getChannelsByBrand(brandId) : [];
      const channelId = channels[0]?.id ?? null;
      const globalPromptHash = crypto.createHash("sha256").update(globalPrompt).digest("hex").slice(0, 8);
      const brandPromptHash = crypto.createHash("sha256").update(brandPrompt).digest("hex").slice(0, 8);
      let simulatedReplySource: string | null = null;
      let wouldUseLlm: boolean | null = null;
      if (testMessage) {
        const riskCheck = detectHighRisk(testMessage);
        const safeConfirmDm = classifyMessageForSafeAfterSale(testMessage);
        if (riskCheck.level === "legal_risk") {
          simulatedReplySource = "high_risk_short_circuit";
          wouldUseLlm = false;
        } else if (safeConfirmDm.matched) {
          simulatedReplySource = "safe_confirm_template";
          wouldUseLlm = false;
        } else {
          const stubContact = {
            id: 0,
            brand_id: brandId ?? null,
            status: "pending",
            needs_human: 0,
            tags: "[]",
            platform: "line",
            order_number_type: null,
            last_message_at: null,
          } as any;
          const state = resolveConversationState({
            contact: stubContact,
            userMessage: testMessage,
            recentUserMessages: [testMessage],
            recentAiMessages: [],
          });
          const returnFormUrl = brand?.return_form_url || "https://www.lovethelife.shop/returns";
          const plan = buildReplyPlan({ state, returnFormUrl, isReturnFirstRound: true });
          if (plan.mode === "off_topic_guard") {
            simulatedReplySource = "off_topic_guard";
            wouldUseLlm = false;
          } else if (plan.mode === "return_form_first") {
            simulatedReplySource = "return_form_first";
            wouldUseLlm = false;
          } else if (plan.mode === "handoff") {
            simulatedReplySource = "handoff";
            wouldUseLlm = true;
          } else {
            simulatedReplySource = "llm";
            wouldUseLlm = true;
          }
        }
      }
      return res.json({
        success: true,
        brand_id: brandId ?? null,
        brand_name: brand?.name || "??",
        channel_id: channelId,
        global_prompt: globalPrompt,
        brand_prompt: brandPrompt,
        global_prompt_hash: globalPromptHash,
        brand_prompt_hash: brandPromptHash,
        full_prompt_length: fullPrompt.length,
        full_prompt_preview: fullPrompt.substring(0, 2000) + (fullPrompt.length > 2000 ? "\n...(truncated)" : ""),
        final_assembled_preview: fullPrompt.substring(0, 2000) + (fullPrompt.length > 2000 ? "\n...(truncated)" : ""),
        final_assembled_length: fullPrompt.length,
        context_stats: {
          knowledge_files: knowledgeFiles.length,
          marketing_rules: marketingRules.length,
          image_assets: imageAssets.length,
          channels: channels.length,
        },
        ...(testMessage
          ? { simulated_reply_source: simulatedReplySource, would_use_llm: wouldUseLlm, test_message: testMessage }
          : {}),
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/api/sandbox/chat", authMiddleware, async (req, res) => {
    const { message, history, brand_id } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, error: "no_api_key", message: "???????????? OpenAI API Key" });
    }
    const systemPrompt = await getEnrichedSystemPrompt(brand_id ? parseInt(brand_id) : undefined);
    try {
      const openai = new OpenAI({ apiKey });
      const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
      ];
      if (Array.isArray(history) && history.length > 0) {
        for (const h of history.slice(-20)) {
          const role = h.role === "assistant" ? "assistant" as const : "user" as const;
          if (h.content && typeof h.content === "string") {
            chatMessages.push({ role, content: h.content });
          }
        }
        console.log(`[Sandbox] ?? ${chatMessages.length - 1} ?????? OpenAI?? Function Calling Tools?`);
      } else {
        chatMessages.push({ role: "user", content: message });
        console.log("[Sandbox] ??????????????? Function Calling Tools?");
      }

      const hasImageAssets = storage.getImageAssets(brand_id ? parseInt(brand_id) : undefined).length > 0;
      const allTools = [...orderLookupTools, ...humanHandoffTools, ...(hasImageAssets ? imageTools : [])];

      let completion = await openai.chat.completions.create({
        model: getOpenAIModel(),
        messages: chatMessages,
        tools: allTools,
        max_completion_tokens: 1000,
        temperature: 0.7,
      });

      let responseMessage = completion.choices[0]?.message;
      let loopCount = 0;
      const maxToolLoops = 3;
      let sandboxImageResult: { image_url?: string; text_message?: string } | null = null;
      let sandboxTransferTriggered = false;
      let sandboxTransferReason = "";
      const sandboxToolLog: string[] = [];

      while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < maxToolLoops) {
        loopCount++;
        console.log(`[Sandbox] AI ?? ${responseMessage.tool_calls.length} ? Tool Call?? ${loopCount} ??`);

        chatMessages.push(responseMessage as OpenAI.Chat.Completions.ChatCompletionMessageParam);

        for (const toolCall of responseMessage.tool_calls) {
          const fn = (toolCall as { function?: { name?: string; arguments?: string } }).function;
          const fnName = fn?.name ?? "";
          let fnArgs: Record<string, string> = {};
          try {
            fnArgs = JSON.parse(fn?.arguments ?? "{}");
          } catch (_e) {
            console.error("[Sandbox] Tool Call ??????:", fn?.arguments);
            chatMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ success: false, error: "???????????" }),
            });
            continue;
          }

          console.log(`[Sandbox] ?? Tool: ${fnName}???:`, fnArgs);
          sandboxToolLog.push(`Tool: ${fnName}(${JSON.stringify(fnArgs)})`);
          const toolResult = await toolExecutor.executeToolCall(fnName, fnArgs, {
            brandId: brand_id ? parseInt(brand_id) : undefined,
            startTime: Date.now(),
            queueWaitMs: 0,
          });
          console.log(`[Sandbox] Tool ??????: ${toolResult.length} ??`);

          if (fnName === "transfer_to_human") {
            sandboxTransferTriggered = true;
            sandboxTransferReason = (fnArgs.reason || "AI ????????").trim();
            sandboxToolLog.push(`>>> AI ???????????????${sandboxTransferReason}`);
          }

          if (fnName === "send_image_to_customer") {
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.image_url) sandboxImageResult = parsed;
            } catch (_e) {}
          }

          chatMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }

        completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          tools: allTools,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        responseMessage = completion.choices[0]?.message;
      }

      let reply = responseMessage?.content || "???AI ???????";
      const result: Record<string, any> = {
        success: true,
        reply,
        transferred: sandboxTransferTriggered,
        tool_log: sandboxToolLog,
      };
      if (sandboxTransferTriggered) {
        result.transfer_reason = sandboxTransferReason;
      }
      if (sandboxImageResult) {
        result.image_url = sandboxImageResult.image_url;
      }
      return res.json(result);
    } catch (err: any) {
      const errorMessage = err?.message || "????";
      if (errorMessage.includes("401") || errorMessage.includes("Incorrect API key") || errorMessage.includes("invalid_api_key")) {
        return res.status(400).json({ success: false, error: "invalid_api_key", message: "OpenAI API Key ???????????????" });
      }
      console.error("[Sandbox] AI ????:", errorMessage);
      return res.status(500).json({ success: false, error: "api_error", message: `AI ?????${errorMessage}` });
    }
  });

  app.post("/api/sandbox/upload", authMiddleware, sandboxUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "?????" });
    const apiKey = storage.getSetting("openai_api_key");
    if (!apiKey || apiKey.trim() === "") {
      return res.status(400).json({ success: false, message: "???????????? OpenAI API Key" });
    }

    const decodedFilename = fixMulterFilename(req.file.originalname);
    console.log("[????] ???????:", decodedFilename);
    const ext = path.extname(decodedFilename).toLowerCase();
    const isVideo = [".mp4", ".mov", ".avi", ".webm"].includes(ext);
    const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
    const fileUrl = `/uploads/${req.file.filename}`;
    const historyRaw = req.body.history;
    let history: { role: string; content: string }[] = [];
    try { history = JSON.parse(historyRaw || "[]"); } catch (_e) {}

    const brandIdParam = req.body.brand_id ? parseInt(req.body.brand_id) : undefined;

    if (isVideo) {
      return res.json({
        success: true,
        reply: `??????????${decodedFilename}??\n\n??? LINE ??????????????????????????????????\n\n?? ?????\n- ???????\n- ???????????\n- ???????????????????????`,
        fileUrl,
        fileType: "video",
        transferred: true,
        transfer_reason: "??????????",
        tool_log: ["Tool: auto_transfer_video()", ">>> ??????????????"],
      });
    }

    if (isImage) {
      try {
        const filePath = path.join(uploadDir, req.file.filename);
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const dataUri = `data:${mimeType};base64,${base64}`;

        const systemPrompt = await getEnrichedSystemPrompt(brandIdParam);
        const openai = new OpenAI({ apiKey });
        const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
        ];
        if (history.length > 0) {
          for (const h of history.slice(-20)) {
            const role = h.role === "assistant" ? "assistant" as const : "user" as const;
            if (h.content && typeof h.content === "string") {
              chatMessages.push({ role, content: h.content });
            }
          }
        }
        chatMessages.push({
          role: "user",
          content: [
            { type: "text", text: "??????????????????????????????????????????" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        });

        const completion = await openai.chat.completions.create({
          model: getOpenAIModel(),
          messages: chatMessages,
          max_completion_tokens: 1000,
          temperature: 0.7,
        });
        const reply = completion.choices[0]?.message?.content || "?????????????????";
        return res.json({ success: true, reply, fileUrl, fileType: "image" });
      } catch (err: any) {
        console.error("[Sandbox Upload] AI Vision error:", err.message);
        return res.json({ success: true, reply: "????????AI ???????????????????", fileUrl, fileType: "image" });
      }
    }

    return res.status(400).json({ message: "???????" });
  });
}
