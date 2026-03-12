/**
 * already_provided 三層搜尋：客戶說「我給過了」時，依優先順序從
 * 1. 近期訊息文字
 * 2. 最近圖片 vision 抽取欄位
 * 3. linked order / 最近查單結果（contact_order_links）
 * 若三層都找不到，再轉真人。
 */
import type OpenAI from "openai";
import db from "./db";

export type MessageLike = { sender_type: string; content?: string | null; message_type?: string; image_url?: string | null };

/** Layer 1：從近期訊息文字抽取訂單編號、手機 */
export function searchOrderInfoInRecentMessages(
  recentMessages: MessageLike[]
): { orderId?: string; phone?: string } {
  const result: { orderId?: string; phone?: string } = {};
  const userContents = recentMessages
    .filter((m) => m.sender_type === "user" && m.content && m.content !== "[圖片訊息]")
    .map((m) => (m.content || "").trim())
    .filter(Boolean);
  for (const text of userContents) {
    const orderMatch = text.match(/\b([A-Z0-9\-]{5,25})\b/);
    if (orderMatch && !result.orderId) result.orderId = orderMatch[1];
    const phoneMatch = text.match(/\b(09\d{8})\b/) || text.match(/\b(\d{10,11})\b/);
    if (phoneMatch && !result.phone) result.phone = phoneMatch[1];
  }
  return result;
}

/** Layer 3：取得該 contact 已連結的訂單編號（依 created_at 由新到舊） */
export function getLinkedOrderIdsForContact(contactId: number): string[] {
  const rows = db.prepare(
    "SELECT global_order_id FROM contact_order_links WHERE contact_id = ? ORDER BY created_at DESC"
  ).all(contactId) as { global_order_id: string }[];
  return rows.map((r) => r.global_order_id);
}

/** Layer 2：用 vision 從圖片抽取訂單編號、手機（訂單/出貨截圖） */
export async function extractOrderInfoFromImage(
  openai: OpenAI,
  imageDataUri: string
): Promise<{ orderId?: string; phone?: string }> {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "這張圖是訂單、出貨或客服對話截圖。請只回覆 JSON 一行，格式：{\"order_id\":\"訂單編號或空字串\",\"phone\":\"手機號碼或空字串\"}。若圖中沒有訂單編號或手機請回 {\"order_id\":\"\",\"phone\":\"\"}。不要其他說明。",
            },
            { type: "image_url", image_url: { url: imageDataUri } },
          ],
        },
      ],
    });
    const content = resp.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const obj = JSON.parse(jsonMatch[0]) as { order_id?: string; phone?: string };
    const orderId = (obj.order_id || "").trim();
    const phone = (obj.phone || "").trim();
    return {
      orderId: orderId.length >= 5 ? orderId : undefined,
      phone: /09\d{8}|\d{10,11}/.test(phone) ? phone : undefined,
    };
  } catch (_e) {
    return {};
  }
}

export type ThreeLayerResult = { orderId?: string; phone?: string; source: "recent_messages" | "image_vision" | "linked_order" };

/**
 * 三層搜尋，命中優先順序：1 → 2 → 3。
 * 僅當前一層完全沒有 orderId 且沒有 phone 時才查下一層。
 */
export async function searchOrderInfoThreeLayers(
  contactId: number,
  recentMessages: MessageLike[],
  options: {
    imageFileToDataUri: (pathOrUrl: string) => string | null;
    openai: OpenAI | null;
  }
): Promise<ThreeLayerResult | null> {
  // Layer 1：近期訊息文字
  const layer1 = searchOrderInfoInRecentMessages(recentMessages);
  if (layer1.orderId || layer1.phone) {
    return { orderId: layer1.orderId, phone: layer1.phone, source: "recent_messages" };
  }

  // Layer 2：最近一張用戶圖片的 vision 抽取
  const lastImageMsg = [...recentMessages]
    .reverse()
    .find((m) => m.sender_type === "user" && m.message_type === "image" && m.image_url);
  if (lastImageMsg?.image_url && options.openai) {
    const dataUri = options.imageFileToDataUri(lastImageMsg.image_url);
    if (dataUri) {
      const layer2 = await extractOrderInfoFromImage(options.openai, dataUri);
      if (layer2.orderId || layer2.phone) {
        return { orderId: layer2.orderId, phone: layer2.phone, source: "image_vision" };
      }
    }
  }

  // Layer 3：linked order / 最近查單結果
  const linked = getLinkedOrderIdsForContact(contactId);
  if (linked.length) {
    return { orderId: linked[0], phone: undefined, source: "linked_order" };
  }

  return null;
}
