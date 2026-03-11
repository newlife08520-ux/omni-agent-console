/**
 * 評價邀請條件：僅在 resolved/closed、非投訴、非退貨爭議未完、非已轉人工、客戶語氣非 angry/high_risk、尚未發過時可發。
 */
import type { Contact } from "@shared/schema";
import type { ConversationState } from "./conversation-state-resolver";

export interface RatingEligibilityInput {
  contact: Contact;
  state?: Partial<ConversationState> | null;
}

export function isRatingEligible(input: RatingEligibilityInput): boolean {
  const { contact, state } = input;
  const status = contact.status as string;
  if (status !== "resolved" && status !== "closed") return false;
  if (contact.status === "awaiting_human" || contact.status === "high_risk") return false;
  const ratingInvitedAt = (contact as any).rating_invited_at;
  if (ratingInvitedAt) return false;
  if (contact.cs_rating != null || contact.ai_rating != null) return false;
  if (state?.primary_intent === "complaint" || state?.customer_emotion === "high_risk" || state?.customer_emotion === "angry") return false;
  if (state?.primary_intent === "refund_or_return" && (contact as any).return_stage !== 3 && (contact as any).return_stage != null) return false;
  return true;
}

export const RATING_INVITE_SUGGESTED_TEXT =
  "今天先幫您處理到這邊😊 如果這次協助對您有幫助，也歡迎幫我們點一下客服評價，讓我們持續做得更好🙏";
