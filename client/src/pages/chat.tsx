import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Send, User, Bot, Headphones, UserCheck, Search, X, Plus, Tag,
  Circle, Zap, Star, Info, Package, Crown, ShoppingBag, Loader2,
  Paperclip, ImageIcon, Upload, CalendarDays, Filter, Phone, MessageSquare,
  UserCog, Users, Pencil, MoreHorizontal, Copy, Link2, Smile, Mic, MapPin, FileText,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useChatView, type ViewMode } from "@/lib/chat-view-context";
import { useToast } from "@/hooks/use-toast";
import type { ContactWithPreview, Message, OrderInfo, ContactStatus, IssueType, OrderSource } from "@shared/schema";
import type { TeamMember } from "@shared/schema";
import { CONTACT_STATUS_LABELS, CONTACT_STATUS_COLORS, ISSUE_TYPE_LABELS, ISSUE_TYPE_COLORS, ORDER_SOURCE_LABELS, CASE_STATUS_VALUES, SYSTEM_MARK_VALUES } from "@shared/schema";

/** 全站統一狀態語意色：紅=超時/高風險、橘=待處理、藍=已分配、綠=已回覆/正常、灰=待分配/離線 */
const STATUS_SEMANTIC = {
  danger: { bg: "bg-red-100 text-red-700 border-red-200", dot: "bg-red-500" },
  warning: { bg: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  assigned: { bg: "bg-blue-100 text-blue-700 border-blue-200", dot: "bg-blue-500" },
  normal: { bg: "bg-green-100 text-green-700 border-green-200", dot: "bg-green-500" },
  muted: { bg: "bg-stone-100 text-stone-600 border-stone-200", dot: "bg-stone-400" },
} as const;

const ORDER_STATUS_MAP: Record<string, { label: string; color: string }> = {
  new_order: { label: "新訂單", color: "bg-blue-50 text-blue-600 border-blue-200" },
  confirming: { label: "確認中", color: "bg-sky-50 text-sky-600 border-sky-200" },
  confirmed: { label: "已確認", color: "bg-indigo-50 text-indigo-600 border-indigo-200" },
  awaiting_for_shipment: { label: "待出貨", color: "bg-amber-50 text-amber-600 border-amber-200" },
  shipping: { label: "出貨中", color: "bg-cyan-50 text-cyan-600 border-cyan-200" },
  shipped: { label: "已出貨", color: "bg-emerald-50 text-emerald-600 border-emerald-200" },
  delay_handling: { label: "延遲出貨", color: "bg-orange-50 text-orange-600 border-orange-200" },
  other: { label: "其他", color: "bg-stone-50 text-stone-600 border-stone-200" },
  refunding: { label: "退款中", color: "bg-pink-50 text-pink-600 border-pink-200" },
  refunded: { label: "已退款", color: "bg-rose-50 text-rose-600 border-rose-200" },
  replacement: { label: "換貨中", color: "bg-purple-50 text-purple-600 border-purple-200" },
  temp: { label: "臨時", color: "bg-stone-50 text-stone-500 border-stone-200" },
  returned: { label: "已退貨", color: "bg-red-50 text-red-600 border-red-200" },
  pending: { label: "待處理", color: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  canceled: { label: "已取消", color: "bg-red-50 text-red-500 border-red-200" },
};

const SHIPPING_METHOD_MAP: Record<string, string> = {
  to_store: "超商取貨",
  to_home: "宅配到家",
};

const PAYMENT_METHOD_MAP: Record<string, string> = {
  none: "無",
  pending: "取件時付款",
  credit_card: "信用卡",
  virtual_account: "ATM 繳費",
  ibon: "ibon 繳費",
  wechatpay: "微信支付",
  installment: "分期付款",
  linepay: "LINE Pay",
};

function parseProductList(raw: string): string {
  try {
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      return items.map((item: any) => `${item.code || item.name || "商品"} x ${item.qty || 1}`).join("\n");
    }
  } catch (_e) {}
  return raw;
}

function formatDateTime(raw?: string): string {
  if (!raw) return "";
  try {
    const normalized = raw.replace(" ", "T") + (raw.includes("+") || raw.includes("Z") ? "" : "Z");
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_e) { return raw; }
}

function formatTime(dateStr: string): string {
  try {
    const normalized = dateStr.replace(" ", "T") + (dateStr.includes("+") || dateStr.includes("Z") ? "" : "Z");
    return new Date(normalized).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei" });
  } catch (_e) { return dateStr; }
}

function formatDate(dateStr: string): string {
  try {
    const normalized = dateStr.replace(" ", "T") + (dateStr.includes("+") || dateStr.includes("Z") ? "" : "Z");
    return new Date(normalized).toLocaleDateString("zh-TW", { month: "short", day: "numeric", timeZone: "Asia/Taipei" });
  } catch (_e) { return dateStr; }
}

/** 節流顯示文字內容，避免串流打字時每字都觸發 DOM 更新造成卡頓（約 80ms 更新一次） */
function ThrottledContent({ content, throttleMs = 80 }: { content: string; throttleMs?: number }) {
  const [displayed, setDisplayed] = useState(content);
  const latestRef = useRef(content);
  const lastTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = content;
    if (content === displayed) return;
    const now = Date.now();
    const elapsed = now - lastTimeRef.current;

    const flush = () => {
      lastTimeRef.current = Date.now();
      setDisplayed(latestRef.current);
      timerRef.current = null;
    };

    if (elapsed >= throttleMs || lastTimeRef.current === 0) {
      flush();
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, throttleMs - elapsed);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, throttleMs]); // eslint-disable-line react-hooks/exhaustive-deps -- displayed intentionally omitted to throttle

  return <>{displayed}</>;
}

/** 單一訊息氣泡：用 memo + 自訂 areEqual，只有 content/資料變動時才 re-render，避免整串歷史一起重繪 */
function areEqualMessageBubble(
  prev: { msg: Message; showDate: boolean; onPreviewImage: (url: string) => void },
  next: { msg: Message; showDate: boolean; onPreviewImage: (url: string) => void },
): boolean {
  if (prev.msg.id !== next.msg.id || prev.showDate !== next.showDate) return false;
  const p = prev.msg;
  const n = next.msg;
  return (
    p.content === n.content &&
    p.created_at === n.created_at &&
    p.sender_type === n.sender_type &&
    p.message_type === n.message_type &&
    (p.image_url ?? "") === (n.image_url ?? "")
  );
}

const MessageBubble = React.memo(function MessageBubble({
  msg,
  showDate,
  onPreviewImage,
}: {
  msg: Message;
  showDate: boolean;
  onPreviewImage: (url: string) => void;
}) {
  if (msg.sender_type === "system") {
    return (
      <div>
        {showDate && (
          <div className="flex justify-center my-5">
            <span className="text-[11px] text-stone-400 bg-white px-3 py-1 rounded-full shadow-sm border border-stone-100">{formatDate(msg.created_at)}</span>
          </div>
        )}
        <div className="flex justify-center" data-testid={`message-${msg.id}`}>
          <div className="flex items-center gap-1.5 bg-stone-100 text-stone-500 text-xs px-4 py-2 rounded-full">
            <Info className="w-3 h-3" />
            {msg.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {showDate && (
        <div className="flex justify-center my-5">
          <span className="text-[11px] text-stone-400 bg-white px-3 py-1 rounded-full shadow-sm border border-stone-100">{formatDate(msg.created_at)}</span>
        </div>
      )}
      <div className={`flex ${msg.sender_type === "user" ? "justify-start" : "justify-end"}`} data-testid={`message-${msg.id}`}>
        <div className={`flex items-end gap-2 max-w-[70%] ${msg.sender_type === "user" ? "flex-row" : "flex-row-reverse"}`}>
          <div className="shrink-0 mb-1">
            {msg.sender_type === "user" ? (
              <Avatar className="w-7 h-7"><AvatarFallback className="bg-stone-200 text-stone-500 text-xs"><User className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
            ) : msg.sender_type === "ai" ? (
              <Avatar className="w-7 h-7"><AvatarFallback className="bg-emerald-100 text-emerald-600 text-xs"><Bot className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
            ) : (
              <Avatar className="w-7 h-7"><AvatarFallback className="bg-amber-600 text-white text-xs"><Headphones className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
            )}
          </div>
          <div>
            {msg.message_type === "image" && msg.image_url ? (
              <div className={`rounded-2xl overflow-hidden shadow-sm ${
                msg.sender_type === "user" ? "rounded-bl-md border border-stone-100"
                  : msg.sender_type === "ai" ? "rounded-br-md border border-emerald-100"
                  : "rounded-br-md"
              }`}>
                <img src={msg.image_url} alt="附件圖片" className="max-w-full max-h-[280px] object-contain cursor-pointer rounded-2xl hover:opacity-90 transition-opacity" onClick={() => onPreviewImage(msg.image_url!)} data-testid={`image-message-${msg.id}`} />
              </div>
            ) : msg.message_type === "video" && msg.image_url ? (
              <div className={`rounded-2xl overflow-hidden shadow-sm ${
                msg.sender_type === "user" ? "rounded-bl-md border border-stone-100"
                  : msg.sender_type === "ai" ? "rounded-br-md border border-emerald-100"
                  : "rounded-br-md"
              }`}>
                <video controls preload="metadata" className="max-w-full max-h-[280px] rounded-2xl bg-black" data-testid={`video-message-${msg.id}`}>
                  <source src={msg.image_url} type="video/mp4" />
                  您的瀏覽器不支援影片播放
                </video>
              </div>
            ) : (() => {
              const c = (msg.content ?? "").trim();
              const placeholderMatch = c.match(/^\[(.+?)訊息\]$/);
              if (placeholderMatch) {
                const type = placeholderMatch[1];
                const icons: Record<string, { Icon: React.ComponentType<{ className?: string }>; label: string }> = {
                  貼圖: { Icon: Smile, label: "貼圖" },
                  音訊: { Icon: Mic, label: "語音訊息" },
                  位置: { Icon: MapPin, label: "位置" },
                  檔案: { Icon: FileText, label: "檔案" },
                };
                const { Icon, label } = icons[type] || { Icon: FileText, label: `${type}訊息` };
                return (
                  <div className={`rounded-2xl px-4 py-2.5 text-sm shadow-sm inline-flex items-center gap-2 ${
                    msg.sender_type === "user" ? "bg-white text-stone-700 rounded-bl-md border border-stone-100"
                      : msg.sender_type === "ai" ? "bg-emerald-50 text-emerald-900 rounded-br-md border border-emerald-100"
                      : "bg-amber-600 text-white rounded-br-md"
                  }`}>
                    <Icon className="w-5 h-5 shrink-0 opacity-80" />
                    <span>{label}</span>
                  </div>
                );
              }
              return (
                <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                  msg.sender_type === "user" ? "bg-white text-stone-700 rounded-bl-md border border-stone-100"
                    : msg.sender_type === "ai" ? "bg-emerald-50 text-emerald-900 rounded-br-md border border-emerald-100"
                    : "bg-amber-600 text-white rounded-br-md"
                }`}>
                  <ThrottledContent content={msg.content} throttleMs={80} />
                </div>
              );
            })()}
            <div className={`text-[10px] text-stone-400 mt-1 ${msg.sender_type === "user" ? "text-left" : "text-right"}`}>
              {msg.sender_type === "ai" ? "AI 助理 " : msg.sender_type === "admin" ? "真人客服 " : ""}{formatTime(msg.created_at)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}, areEqualMessageBubble);

/** 對話代碼：CV-YYYYMMDD-五位數 contact id，供備註貼上 */
function getConversationCode(contactId: number): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const id = String(contactId).padStart(5, "0");
  return `CV-${yyyy}${mm}${dd}-${id}`;
}

/** 系統預設標籤（四層之四：不可從快捷列刪除，僅供快速選取） */
const DEFAULT_TAGS = [
  "VIP", "緊急案件", "待追蹤", "稍後處理", "客訴", "退款", "出貨問題", "商品諮詢", "等主管確認", "回購客",
];

const CUSTOM_TAGS_STORAGE_KEY = "omni_agent_custom_tags";

/** 品牌級常用標籤（四層之三）：擴充方式可為 API GET /api/brands/:id/settings 回傳 shortcut_tags: string[]，或 DB brand_settings.key = 'shortcut_tags'；此輪僅預留，快捷列仍以 DEFAULT_TAGS + 自訂為主。 */
// const BRAND_SHORTCUT_TAGS_KEY = "shortcut_tags";

/** 常用快捷標籤庫（四層之二）：自訂、可新增/刪除/排序，重整後仍存在 */
function getCustomTags(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TAGS_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string" && t.trim()) : [];
  } catch {
    return [];
  }
}

function addCustomTag(tag: string) {
  const t = tag.trim();
  if (!t) return;
  const prev = getCustomTags();
  if (prev.includes(t)) return;
  localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify([...prev, t]));
}

function removeCustomTag(tag: string) {
  const prev = getCustomTags().filter((t) => t !== tag);
  localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify(prev));
}

function setCustomTagsOrder(ordered: string[]) {
  const valid = ordered.filter((t) => typeof t === "string" && t.trim());
  localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify(valid));
}

const TAG_COLORS: Record<string, string> = {
  VIP: "bg-violet-50 text-violet-600 border-violet-200",
  緊急案件: "bg-red-50 text-red-600 border-red-200",
  回購客: "bg-emerald-50 text-emerald-600 border-emerald-200",
  待追蹤: "bg-sky-50 text-sky-600 border-sky-200",
  稍後處理: "bg-amber-50 text-amber-600 border-amber-200",
  客訴: "bg-red-50 text-red-600 border-red-200",
  退款: "bg-pink-50 text-pink-600 border-pink-200",
  出貨問題: "bg-orange-50 text-orange-600 border-orange-200",
  商品諮詢: "bg-indigo-50 text-indigo-600 border-indigo-200",
  等主管確認: "bg-amber-50 text-amber-700 border-amber-200",
  重要: "bg-orange-50 text-orange-600 border-orange-200",
  回購客戶: "bg-emerald-50 text-emerald-600 border-emerald-200",
  新客戶: "bg-sky-50 text-sky-600 border-sky-200",
};

function getTagColor(tag: string) {
  return TAG_COLORS[tag] || "bg-stone-50 text-stone-600 border-stone-200";
}

const QUICK_REPLIES = [
  "感謝您的詢問，我們將盡快為您處理！",
  "請提供您的訂單編號，我將為您查詢。",
  "好的，馬上為您處理，請稍候片刻。",
];

const LIST_OVERDUE_MS = 60 * 60 * 1000;
function listGetStatusLabel(c: ContactWithPreview, currentUserId?: number): string {
  if (["closed", "resolved"].includes(c.status)) return "已結案";
  if (!c.assigned_agent_name && c.needs_human) return "待分配";
  if (c.assigned_agent_name && c.last_message_sender_type === "user") {
    return currentUserId != null && c.assigned_agent_id === currentUserId ? "待我回覆" : "待回覆";
  }
  if (c.assigned_agent_name && (c.last_message_sender_type === "admin" || c.last_message_sender_type === "ai")) return "等客戶回覆";
  if (c.assigned_agent_name) return "處理中";
  return "待分配";
}
function listGetPriorityLabel(c: ContactWithPreview): "高" | "中" | "低" | null {
  const p = c.case_priority;
  if (p == null) return null;
  if (p <= 2) return "高";
  if (p <= 3) return "中";
  return "低";
}
function listGetStatusSemantic(c: ContactWithPreview): keyof typeof STATUS_SEMANTIC {
  if (["closed", "resolved"].includes(c.status)) return "muted";
  if (listIsUrgent(c) || (c as ContactWithPreview).reassign_count > 0) return "danger";
  if (!(c as ContactWithPreview).assigned_agent_name && c.needs_human) return "muted";
  if ((c as ContactWithPreview).assigned_agent_name) {
    if ((c as ContactWithPreview).last_message_sender_type === "user") return "warning";
    return "normal";
  }
  if (["awaiting_human", "pending", "new_case"].includes(c.status)) return "warning";
  return "assigned";
}
function listIsUrgent(c: ContactWithPreview & { is_urgent?: boolean }) {
  return (c as any).is_urgent === true || c.status === "high_risk" || (c.case_priority != null && c.case_priority <= 2);
}
function listIsOverdue(c: ContactWithPreview) {
  if (c.last_message_sender_type !== "user" || !c.last_message_at) return false;
  return Date.now() - new Date(c.last_message_at.replace(" ", "T")).getTime() > LIST_OVERDUE_MS;
}
function listIsUnassigned(c: ContactWithPreview) {
  return !c.assigned_agent_id && c.needs_human === 1;
}
function listIsMine(c: ContactWithPreview, currentUserId?: number) {
  return currentUserId != null && c.assigned_agent_id === currentUserId;
}
function listNeedMyReply(c: ContactWithPreview, currentUserId?: number) {
  return listIsMine(c, currentUserId) && (c.last_message_sender_type === "user" && !["closed", "resolved"].includes(c.status ?? ""));
}
const avatarColorsList = ["bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-sky-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];
function listGetAvatarColor(id: number) {
  return avatarColorsList[id % avatarColorsList.length];
}
function listGetInitials(name: string | undefined | null) {
  return name != null && String(name).trim() ? String(name).trim().slice(0, 1).toUpperCase() : "?";
}
function listFormatTime(s: string | undefined | null) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T"));
  const h = d.getHours();
  const m = d.getMinutes();
  const am = h < 12;
  return `${am ? "上午" : "下午"}${am ? h : h - 12}:${String(m).padStart(2, "0")}`;
}

type ContactListItemProps = {
  contact: ContactWithPreview & { is_urgent?: boolean; is_overdue?: boolean };
  isSelected: boolean;
  currentUserId?: number;
  onSelect: (id: number) => void;
  onPin: (id: number, isPinned: boolean) => void;
  onMouseEnter: (id: number) => void;
};
function contactListItemPropsAreEqual(prev: ContactListItemProps, next: ContactListItemProps): boolean {
  if (prev.contact.id !== next.contact.id) return false;
  if (prev.contact !== next.contact) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.currentUserId !== next.currentUserId) return false;
  return true;
}
const ContactListItem = React.memo(function ContactListItem({ contact, isSelected, currentUserId, onSelect, onPin, onMouseEnter }: ContactListItemProps) {
  const c = contact;
  const semantic = listGetStatusSemantic(c);
  const colors = STATUS_SEMANTIC[semantic];
  const overdue = listNeedMyReply(c, currentUserId) && listIsOverdue(c);
  const urgent = listIsUrgent(c);
  const mine = listIsMine(c, currentUserId);
  const listStatus = listGetStatusLabel(c, currentUserId);
  const unassigned = !c.assigned_agent_name && c.needs_human === 1;
  const pendingMyReply = listStatus === "待我回覆";
  return (
    <div
      onClick={() => { onSelect(contact.id); }}
      onMouseEnter={() => onMouseEnter(contact.id)}
      className={`w-full flex items-start gap-2.5 p-3 rounded-xl text-left transition-all cursor-pointer border-l-[3px] ${
        isSelected
          ? "bg-blue-50/90 border-blue-300 border-l-blue-500"
          : overdue
            ? "border-orange-300 bg-orange-50/50 hover:bg-orange-50/70 border-l-orange-500"
            : urgent
              ? "border-red-200 bg-red-50/40 hover:bg-red-50/60 border-l-red-500"
              : unassigned
                ? "border-amber-200 bg-amber-50/40 hover:bg-amber-50/60 border-l-amber-500"
                : "border-transparent border-l-stone-200 hover:bg-stone-50 hover:border-stone-100"
      }`}
      data-testid={`contact-item-${contact.id}`}
    >
      <div className="relative shrink-0">
        <Avatar className="w-10 h-10">
          {contact.avatar_url && <AvatarImage src={contact.avatar_url} alt={contact.display_name} />}
          <AvatarFallback className={`${listGetAvatarColor(contact.id)} text-white text-xs font-semibold`}>{listGetInitials(contact.display_name)}</AvatarFallback>
        </Avatar>
        {unassigned && (
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-orange-500 rounded-full border-2 border-white" title="待分配" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-1.5 flex-wrap">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <button onClick={(e) => { e.stopPropagation(); onPin(contact.id, !!contact.is_pinned); }} className="shrink-0" data-testid={`button-pin-${contact.id}`}>
              <Star className={`w-3 h-3 ${contact.is_pinned ? "fill-amber-400 text-amber-400" : "text-stone-300 hover:text-amber-400"}`} />
            </button>
            <span className="text-sm font-semibold text-stone-800 truncate">{contact.display_name ?? ""}</span>
            <span className={`shrink-0 text-[9px] font-medium px-1 py-0.5 rounded ${contact.platform === "messenger" ? "bg-blue-100 text-blue-600" : "bg-green-100 text-green-600"}`}>{contact.platform === "messenger" ? "FB" : "LINE"}</span>
            {mine && <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white" data-testid={`badge-mine-${contact.id}`}>我的</span>}
          </div>
          {contact.last_message_at && <span className="text-[10px] text-stone-500 shrink-0 font-medium">{listFormatTime(contact.last_message_at)}</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {unassigned ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-orange-100 text-orange-800 border border-orange-200" title="需人工且尚未分配">待分配</span>
          ) : c.assigned_agent_name ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-stone-700 font-medium truncate max-w-[140px]" title={`負責：${c.assigned_agent_name}`}>
              <Avatar className="w-4 h-4 shrink-0 border border-white shadow-sm">
                {c.assigned_agent_avatar_url && <AvatarImage src={c.assigned_agent_avatar_url} alt={c.assigned_agent_name} />}
                <AvatarFallback className="bg-blue-100 text-blue-700 text-[9px] font-semibold">{c.assigned_agent_name ? String(c.assigned_agent_name).trim().slice(0, 1).toUpperCase() || "?" : "?"}</AvatarFallback>
              </Avatar>
              <span className="truncate">{c.assigned_agent_name}</span>
            </span>
          ) : null}
          <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${pendingMyReply ? "bg-amber-100 text-amber-800 border-amber-300" : colors.bg}`} data-testid={`badge-status-${contact.id}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${pendingMyReply ? "bg-amber-500" : colors.dot}`} />
            {overdue ? "超時未回" : listStatus}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {overdue && <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700" title="超過回覆時限">逾時</span>}
          {urgent && !overdue && <span className="text-[10px] font-medium text-red-600 shrink-0" title="緊急案件">緊急</span>}
          {(contact.vip_level ?? 0) > 0 && <VipBadge level={contact.vip_level ?? 0} />}
          {!urgent && !overdue && (c.my_flag === "later" || c.my_flag === "tracking") && <span className="text-[10px] text-stone-500">{c.my_flag === "tracking" ? "追蹤" : "稍後"}</span>}
        </div>
        {contact.last_message && (
          <p className="text-[11px] text-stone-600 truncate leading-tight max-h-8 flex items-center gap-1" title={contact.last_message}>
            {c.last_message_sender_type && (
              <span className="shrink-0 text-[9px] text-stone-400 font-medium">
                {c.last_message_sender_type === "user" ? "客戶" : c.last_message_sender_type === "admin" ? "客服" : c.last_message_sender_type === "ai" ? "AI" : "系統"}：
              </span>
            )}
            <span className="truncate">{contact.last_message}</span>
          </p>
        )}
      </div>
    </div>
  );
}, contactListItemPropsAreEqual);

function VipBadge({ level }: { level: number }) {
  if (level <= 0) return null;
  const labels = ["", "VIP", "VIP Gold", "VIP Platinum"];
  const colors = ["", "bg-violet-100 text-violet-700 border-violet-300", "bg-amber-100 text-amber-700 border-amber-300", "bg-gradient-to-r from-stone-700 to-stone-500 text-white border-stone-400"];
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${colors[level] || colors[1]}`} data-testid="badge-vip">
      <Crown className="w-2.5 h-2.5" />{labels[level] || "VIP"}
    </span>
  );
}

export default function ChatPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [customTags, setCustomTags] = useState<string[]>(() => getCustomTags());
  const { data: apiTagShortcutsRaw } = useQuery<{ name: string; order: number }[] | null>({
    queryKey: ["/api/settings/tag-shortcuts"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });
  const apiTagShortcuts = Array.isArray(apiTagShortcutsRaw) ? apiTagShortcutsRaw : [];
  const shortcutTagNames = apiTagShortcuts.length > 0 ? apiTagShortcuts.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0)).map((t) => t?.name ?? "").filter(Boolean) : [...DEFAULT_TAGS, ...customTags];
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [rightTab, setRightTab] = useState("info");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchResults, setOrderSearchResults] = useState<OrderInfo[]>([]);
  const [orderSearching, setOrderSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<"simple" | "advanced" | "product">("simple");
  const [advSearchQuery, setAdvSearchQuery] = useState("");
  const [advSearchBegin, setAdvSearchBegin] = useState("");
  const [advSearchEnd, setAdvSearchEnd] = useState("");
  const [productPages, setProductPages] = useState<{ pageId: string; prefix: string; productName: string }[]>([]);
  const [dismissedBotIdHint, setDismissedBotIdHint] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [productPhone, setProductPhone] = useState("");
  const [pageSearchFilter, setPageSearchFilter] = useState("");
  const [pendingFiles, setPendingFiles] = useState<{ file: File; preview: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sendingRating, setSendingRating] = useState(false);
  const [messageSearchResults, setMessageSearchResults] = useState<{ contact_id: number; contact_name: string; message_id: number; content: string; sender_type: string; created_at: string }[]>([]);
  const [messageSearching, setMessageSearching] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<"all" | "line" | "messenger">("all");
  const [showReassignDialog, setShowReassignDialog] = useState(false);
  const [reassignAgentId, setReassignAgentId] = useState<number | null>(null);
  const [reassignNote, setReassignNote] = useState("");
  const [reassigning, setReassigning] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState(false);
  /** AI 串流中尚未寫入 DB 的內容，key = contact_id，收到 new_message 時清掉 */
  const [streamingContent, setStreamingContent] = useState<Record<number, string>>({});
  /** 往上捲動時已載入的較舊訊息（prepend 到主列表上方），切換聯絡人時清空 */
  const [olderMessagesLoaded, setOlderMessagesLoaded] = useState<Message[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const scrollRestorePrevHeightRef = useRef<number>(0);
  const loadOlderTriggeredRef = useRef(false);
  const { viewMode, setViewMode } = useChatView();
  const OVERDUE_MS = 60 * 60 * 1000;
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const quickReplyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;
  const { toast } = useToast();

  /** 僅 invalidate，不 refetch，避免 SSE 觸發大量請求或 re-render 迴圈 */
  const invalidateContactsAndStats = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/contacts"], exact: false });
    queryClient.invalidateQueries({ queryKey: ["/api/manager-stats"], exact: false });
    queryClient.invalidateQueries({ queryKey: ["/api/agent-stats/me"] });
  }, [queryClient]);
  const lastMessageIdRef = useRef<number>(0);
  const { selectedBrandId } = useBrand();

  const sseConnectedRef = useRef(false);
  const [sseConnected, setSseConnected] = useState(true);

  useEffect(() => {
    apiRequest("POST", "/api/notifications/mark-read").catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
  }, [queryClient]);

  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const params = new URLSearchParams(search);
    const contactParam = params.get("contact");
    if (contactParam) {
      const id = parseInt(contactParam, 10);
      if (!isNaN(id)) setSelectedId(id);
    }
    if (params.get("tab") === "orders") setRightTab("orders");
    const orderParam = params.get("order");
    if (orderParam?.trim()) setOrderSearch(orderParam.trim());
  }, []);

  useEffect(() => {
    const search = new URLSearchParams();
    if (selectedId != null) search.set("contact", String(selectedId));
    if (rightTab === "orders") search.set("tab", "orders");
    const q = search.toString();
    const url = q ? `${window.location.pathname}?${q}` : window.location.pathname;
    if (window.location.search !== (q ? `?${q}` : "")) {
      window.history.replaceState(null, "", url);
    }
  }, [selectedId, rightTab]);

  // SSE：僅在 mount 時綁定一次，deps=[] 避免點擊聯絡人重選時重複註冊造成「影分身」與死循環。
  // 內部只用 queryClientRef.current，絕不把 selectedId 等會變動的狀態放入 deps。cleanup 必須 close source。
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let retryCount = 0;

    function connect() {
      try {
        es = new EventSource("/api/events", { withCredentials: true });
        es.addEventListener("connected", () => {
          sseConnectedRef.current = true;
          setSseConnected(true);
          retryCount = 0;
          console.log("[SSE] Connected successfully");
        });
        es.addEventListener("message_chunk", (e) => {
          try {
            const data = JSON.parse(e.data) as { contact_id?: number; chunk?: string };
            if (data.contact_id != null && typeof data.chunk === "string") {
              setStreamingContent((prev) => ({ ...prev, [data.contact_id!]: (prev[data.contact_id!] ?? "") + data.chunk }));
            }
          } catch (err) {
            console.error("[SSE] Error parsing message_chunk:", err);
          }
        });
        es.addEventListener("new_message", (e) => {
          try {
            const data = JSON.parse(e.data) as { contact_id?: number };
            const contactId = data?.contact_id;
            console.log("[SSE] new_message received, contact:", contactId);
            setStreamingContent((prev) => {
              const next = { ...prev };
              if (contactId != null) delete next[contactId];
              return next;
            });
            const q = queryClientRef.current;
            q.invalidateQueries({ queryKey: ["/api/contacts"], exact: false });
            if (contactId != null) q.invalidateQueries({ queryKey: ["/api/contacts", contactId, "messages"] });
            q.invalidateQueries({ queryKey: ["/api/manager-stats"], exact: false });
            q.invalidateQueries({ queryKey: ["/api/agent-stats/me"] });
          } catch (err) {
            console.error("[SSE] Error parsing new_message:", err);
          }
        });
        es.addEventListener("contacts_updated", () => {
          console.log("[SSE] contacts_updated received");
          const q = queryClientRef.current;
          q.invalidateQueries({ queryKey: ["/api/contacts"], exact: false });
          q.invalidateQueries({ queryKey: ["/api/manager-stats"], exact: false });
          q.invalidateQueries({ queryKey: ["/api/agent-stats/me"] });
        });
        es.onerror = (err) => {
          console.error("[SSE] Connection error, retry #" + retryCount, err);
          sseConnectedRef.current = false;
          setSseConnected(false);
          es?.close();
          retryCount++;
          const delay = Math.min(3000 * retryCount, 15000);
          reconnectTimer = setTimeout(connect, delay);
        };
      } catch (err) {
        console.error("[SSE] Failed to create EventSource:", err);
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();
    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
      sseConnectedRef.current = false;
      setSseConnected(false);
    };
  }, []);

  const { data: contactsRaw = [], isLoading: contactsLoading, isError: contactsError } = useQuery<(ContactWithPreview & { is_urgent?: boolean; is_overdue?: boolean })[]>({
    queryKey: ["/api/contacts", selectedBrandId, viewMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId) params.set("brand_id", String(selectedBrandId));
      if (viewMode === "my" || viewMode === "tracking") params.set("assigned_to_me", "1");
      if (viewMode === "my" || viewMode === "pending") params.set("need_reply_first", "1");
      const url = params.toString() ? `/api/contacts?${params}` : "/api/contacts";
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });
  const contacts = Array.isArray(contactsRaw) ? contactsRaw : [];

  const { data: messagesRaw, isLoading: messagesLoading, isFetching: messagesFetching } = useQuery<Message[]>({
    queryKey: ["/api/contacts", selectedId, "messages"],
    queryFn: async () => {
      if (!selectedId) return [];
      const res = await fetch(`/api/contacts/${selectedId}/messages`, {
        credentials: "include",
        headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: !!selectedId,
    refetchInterval: 10000,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
  const messages = Array.isArray(messagesRaw) ? messagesRaw : [];

  /** 滑過聯絡人時預先拉取訊息，點開時常已就緒（秒開）。僅依賴 queryClient 以穩定引用，避免 3000+ 聯絡人一併 re-render */
  const prefetchMessagesForContact = useCallback(
    (contactId: number) => {
      if (contactId === selectedIdRef.current) return;
      queryClient.prefetchQuery({
        queryKey: ["/api/contacts", contactId, "messages"],
        queryFn: async () => {
          const res = await fetch(`/api/contacts/${contactId}/messages`, {
            credentials: "include",
            headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
          });
          if (!res.ok) throw new Error("Failed");
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        },
        staleTime: 5 * 60 * 1000,
      });
    },
    [queryClient]
  );

  /** 穩定 callback：點選聯絡人，僅兩筆 item（取消選取/新選取）會 re-render */
  const handleSelectContact = useCallback((id: number) => {
    setSelectedId(id);
    lastMessageIdRef.current = 0;
  }, []);

  const { data: linkedOrderIds = [] } = useQuery<string[]>({
    queryKey: ["/api/contacts", selectedId, "linked-orders"],
    queryFn: async () => {
      if (!selectedId) return [];
      const res = await fetch(`/api/contacts/${selectedId}/linked-orders`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.order_ids) ? data.order_ids : [];
    },
    enabled: !!selectedId,
  });

  const orderSearchResultsSafe = orderSearchResults ?? [];
  const orderIdsForLinked = orderSearchResultsSafe.map((o) => o.global_order_id);
  const { data: linkedContactsMap = {} } = useQuery<Record<string, number | null>>({
    queryKey: ["/api/orders/linked-contacts", orderIdsForLinked.join(",")],
    queryFn: async () => {
      if (orderIdsForLinked.length === 0) return {};
      const res = await fetch(`/api/orders/linked-contacts?order_ids=${orderIdsForLinked.map(encodeURIComponent).join(",")}`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: orderIdsForLinked.length > 0,
  });

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    requestAnimationFrame(() => {
      const viewport = chatViewportRef.current;
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      }
    });
  }, []);

  useEffect(() => {
    const msgs = messages ?? [];
    if (msgs.length > 0) {
      const latest = msgs[msgs.length - 1];
      const latestId = latest?.id;
      if (latestId != null && latestId > lastMessageIdRef.current) {
        const isFirstLoad = lastMessageIdRef.current === 0;
        lastMessageIdRef.current = latestId;
        scrollToBottom(isFirstLoad ? "auto" : "smooth");
      }
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    lastMessageIdRef.current = 0;
    setOlderMessagesLoaded([]);
    setHasMoreOlder(true);
    loadOlderTriggeredRef.current = false;
    scrollToBottom("auto");
  }, [selectedId, scrollToBottom]);

  useEffect(() => {
    if (selectedId != null && streamingContent[selectedId]) {
      scrollToBottom("smooth");
    }
  }, [selectedId, streamingContent, scrollToBottom]);

  const displayMessages = useMemo(() => {
    const older = Array.isArray(olderMessagesLoaded) ? olderMessagesLoaded : [];
    const msgs = Array.isArray(messages) ? messages : [];
    return [...older, ...msgs];
  }, [olderMessagesLoaded, messages]);

  const displayMessagesLength = displayMessages?.length ?? 0;

  if (typeof import.meta !== "undefined" && import.meta.env?.PROD) {
    console.log("[ChatPage] render", { contactsLen: (contacts ?? []).length, displayMessagesLen: (displayMessages ?? []).length, selectedId, hasMessagesArray: Array.isArray(messages) });
  }

  const loadOlderMessages = useCallback(async () => {
    if (!selectedId || loadingOlder || !hasMoreOlder) return;
    const older = olderMessagesLoaded ?? [];
    const msgs = messages ?? [];
    const oldest = older.length > 0 ? older[0] : msgs[0];
    const oldestId = oldest?.id;
    if (oldestId == null || oldestId <= 0) return;
    setLoadingOlder(true);
    loadOlderTriggeredRef.current = true;
    try {
      const res = await fetch(
        `/api/contacts/${selectedId}/messages?before_id=${oldestId}&limit=100`,
        { credentials: "include", headers: { "Cache-Control": "no-cache" } }
      );
      if (!res.ok) throw new Error("Failed");
      const older: Message[] = await res.json();
      const viewport = chatViewportRef.current;
      if (viewport) scrollRestorePrevHeightRef.current = viewport.scrollHeight;
      setOlderMessagesLoaded((prev) => [...older, ...prev]);
      setHasMoreOlder(older.length >= 100);
    } catch (_e) {
      setHasMoreOlder(false);
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedId, loadingOlder, hasMoreOlder, olderMessagesLoaded, messages]);

  useLayoutEffect(() => {
    if (!loadOlderTriggeredRef.current || !chatViewportRef.current) return;
    loadOlderTriggeredRef.current = false;
    const el = chatViewportRef.current;
    const prev = scrollRestorePrevHeightRef.current;
    if (prev <= 0) return;
    const added = el.scrollHeight - prev;
    if (added > 0) el.scrollTop += added;
    scrollRestorePrevHeightRef.current = 0;
  }, [olderMessagesLoaded]);

  const SCROLL_LOAD_THRESHOLD = 80;
  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      if (viewport.scrollTop <= SCROLL_LOAD_THRESHOLD && displayMessagesLength > 0 && !loadingOlder && hasMoreOlder) {
        loadOlderMessages();
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [displayMessagesLength, loadingOlder, hasMoreOlder, loadOlderMessages]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (quickReplyRef.current && !quickReplyRef.current.contains(e.target as Node)) setShowQuickReplies(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const prevHumanCountRef = useRef<number>(0);
  useEffect(() => {
    const list = contacts ?? [];
    const humanCount = list.filter(c => c.needs_human).length;
    if (humanCount > prevHumanCountRef.current && prevHumanCountRef.current >= 0) {
      try {
        const audio = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgiq2up3hOMjdkjK+smXBILTRlj7CsmG9HLDVmkLCsmG9HLDVmkLCsmG5HLTVmkLCsmG5HLTVmkbGtmXBILDVmkLCsmG5HLTVnkbGtmXBILDVmkLCsmG5HLTRlkLCsmXBILjVljq+smXBJLTRlkLCsmXBJLTRlj7CsmG9ILTRlj7CsmG9ILDVmkLCsmG9ILDVmkLCsmXBILDVmkLCsmXBILDVmkLCsmXBILDVmkLCsmXBILDVmkbGtmXBILTVmkbGtmXBILTVmkbGtmXBILTVnkbGtmXBJLTVnkbGtmXBJLjZnkbKumXBJLjZokrKumnFKLjZokrKumnFKLzZokrKumnFKLzZpk7OvmnJKLzZpk7OvmnJKLzZplLOwm3NLLzZqlLOwm3NLMDdqlLOwm3NMMDdqlLOwnHRMMDdrlbSxnHRNMTdrlbSxnHRNMThslrWynXVOMjhslrWynXVOMjhtl7WynXZPMjhtl7aznndPMzhtl7aznndPMzlumLaznndQMzlumLe0n3hQNDlvmbe0n3hRNDlvmbi1oHlRNTpvmbi1oHlRNTpwmrm2oXpSNjpwmrm2oXpSNjpwm7m2oXtTNztxm7q3ontTNztxm7q3o3xUODtxnLu4o3xUODtxnLu4pHxVOTxynby5pX1WOTxynby5pX1WOj1zn726pn5XOj1zn726pn5XOz10oL67p39YPD50oL+8qIBZPD50oL+8qIBZPT91ocC9qYFaPj91ocC9qYFaPj91oc==");
        audio.volume = 0.3;
        audio.play().catch(() => {});
      } catch (_e) {}
      if (Notification.permission === "granted") {
        new Notification("客服中心", { body: "有新的對話需要人工處理", icon: "/favicon.ico" });
      } else if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
    prevHumanCountRef.current = humanCount;
  }, [contacts]);
  const contactsSafe = contacts ?? [];

  const { data: authUser } = useQuery<{ user?: { id: number; role: string; username?: string; display_name?: string } }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const selectedContact = contactsSafe.find((c) => c.id === selectedId);
  const isOverdue = (c: ContactWithPreview) => {
    if ((c as ContactWithPreview).last_message_sender_type !== "user" || !c.last_message_at) return false;
    return Date.now() - new Date(c.last_message_at.replace(" ", "T")).getTime() > OVERDUE_MS;
  };
  /** 緊急案件：後端回傳 is_urgent，或 fallback 狀態/優先級 */
  const isUrgent = (c: ContactWithPreview & { is_urgent?: boolean }) =>
    (c as any).is_urgent === true || c.status === "high_risk" || (c.case_priority != null && c.case_priority <= 2);
  const isUnassigned = (c: ContactWithPreview) => !c.assigned_agent_id && c.needs_human === 1;
  /** 我的案件：已分配給目前登入客服 */
  const isMine = (c: ContactWithPreview) => authUser?.user?.id != null && c.assigned_agent_id === authUser.user.id;
  /**
   * 是否「輪到有人回覆」：最後一則訊息為客戶發言 + 未結案。
   * 若最後一則為 AI / 客服 / 系統，則不算（客戶已讀或等客戶回覆）。
   * 後端依 messages 表最後一筆的 sender_type 填入 last_message_sender_type。
   */
  const needReply = (c: ContactWithPreview) => {
    const sender = c.last_message_sender_type != null ? String(c.last_message_sender_type).toLowerCase() : "";
    return sender === "user" && !["closed", "resolved"].includes(c.status ?? "");
  };
  /** 待我回覆：我的案件 + 輪到我回覆（分配給我 + 最後一則為客戶 + 未結案） */
  const needMyReply = (c: ContactWithPreview) => isMine(c) && needReply(c);

  const filteredContacts = contactsSafe
    .filter((c) => (c.display_name ?? "").toLowerCase().includes(searchQuery.toLowerCase()))
    .filter((c) => platformFilter === "all" || c.platform === platformFilter)
    .filter((c) => {
      if (viewMode === "my") return isMine(c) && !["closed", "resolved"].includes(c.status);
      if (viewMode === "pending") return needMyReply(c);
      if (viewMode === "high_risk") return isUrgent(c) && !["closed", "resolved"].includes(c.status);
      if (viewMode === "tracking") return isMine(c) && (c as ContactWithPreview).my_flag === "tracking" && !["closed", "resolved"].includes(c.status);
      if (viewMode === "overdue") return isOverdue(c) && !["closed", "resolved"].includes(c.status);
      if (viewMode === "unassigned") return isUnassigned(c);
      return true;
    })
    .sort((a, b) => {
      const ac = a as ContactWithPreview & { is_urgent?: boolean };
      const bc = b as ContactWithPreview & { is_urgent?: boolean };
      const aUrgent = isUrgent(ac);
      const bUrgent = isUrgent(bc);
      if (aUrgent !== bUrgent) return aUrgent ? -1 : 1;
      const aOverdue = isOverdue(a);
      const bOverdue = isOverdue(b);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      const aUnassigned = isUnassigned(a);
      const bUnassigned = isUnassigned(b);
      if (aUnassigned !== bUnassigned) return aUnassigned ? -1 : 1;
      if ((a.vip_level ?? 0) !== (b.vip_level ?? 0)) return (b.vip_level ?? 0) - (a.vip_level ?? 0);
      const aAt = a.last_message_at || "";
      const bAt = b.last_message_at || "";
      return bAt.localeCompare(aAt);
    });

  /** 虛擬滾動：只渲染可見約十幾筆，破千聯絡人也不卡。count 防禦避免 undefined.length 主畫面崩潰 */
  const listScrollRef = useRef<HTMLDivElement>(null);
  const contactListSafe = Array.isArray(filteredContacts) ? filteredContacts : [];
  const rowVirtualizer = useVirtualizer({
    count: contactListSafe.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: 96,
    overscan: 8,
  });

  /** 切換篩選後若目前選中的聯絡人不在結果內：改選第一筆或清空，避免右側顯示失效或白屏 */
  const filteredIdsKey = contactListSafe.map((c) => c.id).join(",");
  useEffect(() => {
    const ids = filteredIdsKey ? filteredIdsKey.split(",").map(Number) : [];
    const inList = selectedId != null && ids.includes(selectedId);
    if (inList) return;
    setSelectedId(ids.length > 0 ? ids[0] : null);
  }, [viewMode, filteredIdsKey, selectedId]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.trim().length >= 2) {
      setMessageSearching(true);
      searchTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/messages/search?q=${encodeURIComponent(value.trim())}`, { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            setMessageSearchResults(Array.isArray(data) ? data : []);
          }
        } catch (_e) {}
        setMessageSearching(false);
      }, 400);
    } else {
      setMessageSearchResults([]);
      setMessageSearching(false);
    }
  }, []);

  const handleSendMessage = useCallback(async () => {
    if (!messageInput.trim() || !selectedId || sending) return;
    const contactId = selectedId;
    const content = messageInput.trim();
    const platform = contactsSafe.find((c) => c.id === contactId)?.platform ?? "line";

    setMessageInput("");

    const tempId = -Date.now();
    const optimisticMessage: Message = {
      id: tempId,
      contact_id: contactId,
      platform,
      sender_type: "admin",
      content,
      message_type: "text",
      image_url: null,
      created_at: new Date().toISOString(),
    };

    queryClient.setQueryData<Message[]>(["/api/contacts", contactId, "messages"], (prev) => {
      const list = Array.isArray(prev) ? prev : [];
      return [...list, optimisticMessage];
    });

    setSending(true);
    try {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/messages`, { content });
      const message = (await res.json()) as Message;

      queryClient.setQueryData<Message[]>(["/api/contacts", contactId, "messages"], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return list.map((m) => (m.id === tempId ? message : m));
      });

      invalidateContactsAndStats();
    } catch (_e) {
      queryClient.setQueryData<Message[]>(["/api/contacts", contactId, "messages"], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return list.filter((m) => m.id !== tempId);
      });
      toast({ title: "傳送失敗", variant: "destructive" });
    } finally {
      setSending(false);
    }
  }, [messageInput, selectedId, sending, queryClient, toast, invalidateContactsAndStats, contactsSafe]);

  const [transferReason, setTransferReason] = useState("");

  const handleTransferHuman = async (contactId: number) => {
    try {
      await apiRequest("POST", `/api/contacts/${contactId}/transfer-human`, { reason: transferReason || "管理員手動轉接" });
      setTransferReason("");
      invalidateContactsAndStats();
      toast({ title: "已轉接真人客服" });
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleRestoreAi = async (contactId: number) => {
    try {
      await apiRequest("POST", `/api/contacts/${contactId}/restore-ai`, {});
      invalidateContactsAndStats();
      toast({ title: "已恢復 AI 接管" });
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleToggleHuman = async (contactId: number, currentFlag: number) => {
    if (currentFlag) {
      await handleRestoreAi(contactId);
    } else {
      await handleTransferHuman(contactId);
    }
  };

  const handleStatusChange = async (status: string) => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
      invalidateContactsAndStats();
      if (status === "resolved" && selectedContact?.platform === "line") {
        toast({ title: "已標記為已解決", description: "系統將自動發送滿意度調查卡片給客戶" });
      }
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const isManager = authUser?.user?.role === "super_admin" || authUser?.user?.role === "marketing_manager";
  const isCsAgent = authUser?.user?.role === "cs_agent";

  useEffect(() => {
    if (!isCsAgent) return;
    const setOnline = () => apiRequest("PUT", "/api/agent-status/me", { is_online: true, is_available: true }).catch(() => {});
    setOnline();
    const heartbeat = setInterval(setOnline, 50000);
    return () => {
      clearInterval(heartbeat);
      apiRequest("PUT", "/api/agent-status/me", { is_online: false }).catch(() => {});
    };
  }, [isCsAgent]);

  const { data: availableAgents } = useQuery<{ id: number; display_name: string; avatar_url?: string | null; is_online?: number; is_available?: number; last_active_at?: string | null; open_cases_count?: number; max_active_conversations?: number; can_assign?: boolean; on_duty?: number; work_start_time?: string; work_end_time?: string; is_in_work?: boolean }[]>({
    queryKey: ["/api/team/available-agents"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: isManager,
  });
  const agentList = Array.isArray(availableAgents) ? availableAgents : [];
  const agentListByLoad = [...agentList].sort((a, b) => (a.open_cases_count ?? 0) - (b.open_cases_count ?? 0));

  const formatLastActive = (lastActive: string | null | undefined) => {
    if (!lastActive) return "從未";
    try {
      const d = new Date(lastActive);
      if (Number.isNaN(d.getTime())) return "從未";
      return d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "從未";
    }
  };

  const { data: assignmentData } = useQuery<{
    assigned_to_user_id: number | null;
    assigned_at: string | null;
    assignment_status: string | null;
    assignment_method: string | null;
    assignment_reason?: string | null;
    last_human_reply_at: string | null;
    reassign_count: number;
    needs_assignment: number;
    response_sla_deadline_at: string | null;
    assigned_agent_name: string | null;
    assigned_agent_avatar_url: string | null;
  }>({
    queryKey: ["/api/contacts", selectedId ?? 0, "assignment"],
    queryFn: () => apiRequest("GET", `/api/contacts/${selectedId}/assignment`) as Promise<any>,
    enabled: !!selectedId,
  });

  const { data: contactDetail } = useQuery<{ ai_suggestions?: string | null }>({
    queryKey: ["/api/contacts", selectedId ?? 0, "detail"],
    queryFn: async () => {
      const res = await fetch(`/api/contacts/${selectedId}`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    enabled: !!selectedId,
  });
  const aiSuggestions = (() => {
    try {
      const raw = contactDetail?.ai_suggestions;
      if (typeof raw !== "string" || !raw) return null;
      return JSON.parse(raw) as { issue_type?: string; status?: string; priority?: string; tags?: string[] };
    } catch { return null; }
  })();

  const handleUnassign = async () => {
    if (!selectedId) return;
    try {
      const res = await apiRequest("POST", `/api/contacts/${selectedId}/unassign`);
      const data = await res.json();
      if (data?.success && data != null) {
        const { success: _s, ...payload } = data;
        queryClient.setQueryData(["/api/contacts", selectedId, "assignment"], (prev: any) => ({ ...(prev ?? {}), ...payload }));
        queryClient.setQueryData(["/api/contacts", selectedBrandId], (old: ContactWithPreview[] | undefined) => {
          if (!Array.isArray(old)) return old;
          return old.map((c) => c.id === selectedId ? { ...c, assigned_agent_id: null, assigned_agent_name: undefined, assigned_agent_avatar_url: null } : c);
        });
      }
      invalidateContactsAndStats();
      toast({ title: "已移回待分配" });
    } catch (_e) {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleAssign = async () => {
    if (!selectedId) return;
    try {
      const res = await apiRequest("POST", `/api/contacts/${selectedId}/assign`);
      const data = await res.json();
      if (data?.success && data != null) {
        const { success: _s, assigned_agent_id: _id, ...payload } = data;
        const agentId = data.assigned_to_user_id ?? data.assigned_agent_id;
        queryClient.setQueryData(
          ["/api/contacts", selectedId, "assignment"],
          (prev: any) => ({ ...(prev ?? {}), ...payload, assigned_to_user_id: agentId })
        );
        if (agentId != null) {
          queryClient.setQueryData(["/api/contacts", selectedBrandId], (old: ContactWithPreview[] | undefined) => {
            if (!Array.isArray(old)) return old;
            return old.map((c) => c.id === selectedId ? { ...c, assigned_agent_id: agentId, assigned_agent_name: data.assigned_agent_name ?? c.assigned_agent_name, assigned_agent_avatar_url: data.assigned_agent_avatar_url ?? c.assigned_agent_avatar_url ?? null } : c);
          });
        }
      }
      invalidateContactsAndStats();
      toast({ title: "已自動分配客服" });
      setShowAssignDialog(false);
    } catch (e: any) {
      let msg = "分配失敗，請稍後再試";
      const raw = e?.message ?? "";
      const bodyStr = raw.includes(": ") ? raw.split(": ").slice(1).join(": ") : "";
      if (bodyStr) try { const j = JSON.parse(bodyStr); if (j?.message) msg = j.message; } catch { /* ignore */ }
      if (raw.includes("503")) msg = "目前無可接案客服（請確認有客服在即時客服頁上線，且目前時間在設定的上班時段內）";
      if (/CHECK constraint|constraint failed|SQLITE_CONSTRAINT/i.test(raw)) msg = "分配時更新狀態失敗，請重新整理頁面後再試。";
      toast({ title: msg, variant: "destructive" });
      setShowAssignDialog(false);
    }
  };

  const handleAssignToAgent = async () => {
    if (!selectedId || assignAgentId == null) return;
    await handleAssignToAgentWith(selectedId, assignAgentId);
  };

  const handleAssignToAgentWith = async (contactId: number, agentId: number) => {
    setAssigning(true);
    try {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/assign`, { agent_id: agentId }, { "X-Assign-Agent-Id": String(agentId) });
      const data = await res.json();
      if (data?.success && data != null) {
        const { success: _s, assigned_agent_id: _id, ...payload } = data;
        const assignedUserId = data.assigned_to_user_id ?? data.assigned_agent_id;
        queryClient.setQueryData(
          ["/api/contacts", contactId, "assignment"],
          (prev: any) => ({ ...(prev ?? {}), ...payload, assigned_to_user_id: assignedUserId })
        );
        if (assignedUserId != null) {
          queryClient.setQueryData(["/api/contacts", selectedBrandId], (old: ContactWithPreview[] | undefined) => {
            if (!Array.isArray(old)) return old;
            return old.map((c) => c.id === contactId ? { ...c, assigned_agent_id: assignedUserId, assigned_agent_name: data.assigned_agent_name ?? c.assigned_agent_name, assigned_agent_avatar_url: data.assigned_agent_avatar_url ?? c.assigned_agent_avatar_url ?? null } : c);
          });
        }
      }
      invalidateContactsAndStats();
      toast({ title: "已指派給選定客服" });
      setShowAssignDialog(false);
      setAssignAgentId(null);
    } catch (e: any) {
      let msg = "指派失敗，請稍後再試";
      const raw = e?.message ?? "";
      const bodyStr = raw.includes(": ") ? raw.split(": ").slice(1).join(": ") : "";
      if (bodyStr) {
        try {
          const j = JSON.parse(bodyStr);
          if (j?.message) msg = j.message;
        } catch { /* ignore */ }
      }
      if (/CHECK constraint|constraint failed|SQLITE_CONSTRAINT/i.test(raw)) msg = "指派時更新狀態失敗，請重新整理頁面後再試。";
      toast({ title: msg, variant: "destructive" });
      setShowAssignDialog(false);
      setAssignAgentId(null);
    } finally {
      setAssigning(false);
    }
  };

  const handleReassignSubmit = async () => {
    if (!selectedId || reassignAgentId == null) return;
    setReassigning(true);
    try {
      const res = await apiRequest("POST", `/api/contacts/${selectedId}/reassign`, { new_agent_id: reassignAgentId, note: reassignNote || undefined });
      const data = await res.json();
      if (data?.success && data != null) {
        const { success: _s, ...payload } = data;
        const assignedUserId = data.assigned_to_user_id ?? null;
        queryClient.setQueryData(["/api/contacts", selectedId, "assignment"], (prev: any) => ({ ...(prev ?? {}), ...payload }));
        queryClient.setQueryData(["/api/contacts", selectedBrandId], (old: ContactWithPreview[] | undefined) => {
          if (!Array.isArray(old)) return old;
          return old.map((c) => c.id === selectedId ? { ...c, assigned_agent_id: assignedUserId, assigned_agent_name: data.assigned_agent_name ?? c.assigned_agent_name, assigned_agent_avatar_url: data.assigned_agent_avatar_url ?? c.assigned_agent_avatar_url } : c);
        });
      }
      invalidateContactsAndStats();
      toast({ title: "已改派客服" });
      setShowReassignDialog(false);
      setReassignAgentId(null);
      setReassignNote("");
    } catch (e: any) {
      let msg = "改派失敗，請稍後再試";
      const raw = e?.message ?? "";
      const bodyStr = raw.includes(": ") ? raw.split(": ").slice(1).join(": ") : "";
      if (bodyStr) try { const j = JSON.parse(bodyStr); if (j?.message) msg = j.message; } catch { /* ignore */ }
      if (/CHECK constraint|constraint failed|SQLITE_CONSTRAINT/i.test(raw)) msg = "改派時更新狀態失敗，請重新整理頁面後再試。";
      toast({ title: msg, variant: "destructive" });
      setShowReassignDialog(false);
    } finally {
      setReassigning(false);
    }
  };

  const handleTogglePin = useCallback(async (contactId: number, currentPinned: number) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/pinned`, { is_pinned: currentPinned ? 0 : 1 });
      invalidateContactsAndStats();
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
  }, [invalidateContactsAndStats, toast]);

  const handleSetAgentFlag = async (contactId: number, flag: "later" | "tracking" | null) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/agent-flag`, { flag });
      invalidateContactsAndStats();
      toast({ title: flag === null ? "已清除標記" : flag === "later" ? "已標記稍後處理" : "已標記追蹤中" });
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleIssueTypeChange = async (issueType: string) => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/issue-type`, { issue_type: issueType || null });
      invalidateContactsAndStats();
    } catch (_e) { toast({ title: "更新問題類型失敗", variant: "destructive" }); }
  };

  const handleAddTag = async () => {
    if (!newTag.trim() || !selectedContact) return;
    const tag = newTag.trim();
    let currentTags: string[] = [];
    try {
      const v = JSON.parse(selectedContact.tags || "[]");
      currentTags = Array.isArray(v) ? v : [];
    } catch { /* ignore */ }
    if (currentTags.includes(tag)) { setNewTag(""); return; }
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: [...currentTags, tag] });
      invalidateContactsAndStats();
      setNewTag("");
      addCustomTag(tag);
      setCustomTags(getCustomTags());
    } catch (_e) { toast({ title: "新增標籤失敗", variant: "destructive" }); }
  };

  const handleAddTagWithValue = async (tag: string) => {
    if (!selectedContact || !tag.trim()) return;
    let currentTags: string[] = [];
    try {
      const v = JSON.parse(selectedContact.tags || "[]");
      currentTags = Array.isArray(v) ? v : [];
    } catch { /* ignore */ }
    if (currentTags.includes(tag.trim())) return;
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: [...currentTags, tag.trim()] });
      invalidateContactsAndStats();
    } catch (_e) { toast({ title: "新增標籤失敗", variant: "destructive" }); }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!selectedContact) return;
    let currentTags: string[] = [];
    try {
      const v = JSON.parse(selectedContact.tags || "[]");
      currentTags = Array.isArray(v) ? v : [];
    } catch { /* ignore */ }
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: currentTags.filter((t) => t !== tagToRemove) });
      invalidateContactsAndStats();
    } catch (_e) { toast({ title: "移除標籤失敗", variant: "destructive" }); }
  };

  const handleOrderSearch = async () => {
    if (!orderSearch.trim()) return;
    setOrderSearching(true);
    try {
      const res = await fetch(`/api/orders/lookup?q=${encodeURIComponent(orderSearch.trim())}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = Array.isArray(data.orders) ? data.orders : [];
      setOrderSearchResults(orders);
      if (selectedId && orders.length > 0) {
        for (const o of orders) {
          try {
            await fetch(`/api/contacts/${selectedId}/link-order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ order_id: o.global_order_id }),
            });
          } catch (_) {}
        }
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "linked-orders"] });
      }
      if (data?.error) {
        toast({ title: data?.message || "查詢失敗", variant: "destructive" });
      } else if (orders.length === 0) {
        toast({ title: "未找到相關訂單" });
      }
    } catch (_e) { toast({ title: "查詢失敗", variant: "destructive" }); }
    finally { setOrderSearching(false); }
  };

  const handleAdvancedSearch = async () => {
    if (!advSearchQuery.trim() || !advSearchBegin || !advSearchEnd) return;
    setOrderSearching(true);
    try {
      const params = new URLSearchParams({
        q: advSearchQuery.trim(),
        begin_date: advSearchBegin,
        end_date: advSearchEnd,
      });
      const res = await fetch(`/api/orders/search?${params}`, { credentials: "include" });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        toast({ title: errData?.message || "查詢失敗", variant: "destructive" });
        return;
      }
      const data = await res.json();
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      setOrderSearchResults(orders);
      if (selectedId && orders.length > 0) {
        for (const o of orders) {
          try {
            await fetch(`/api/contacts/${selectedId}/link-order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ order_id: o.global_order_id }),
            });
          } catch (_) {}
        }
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "linked-orders"] });
      }
      if (data?.error) {
        toast({ title: data?.message || "查詢失敗", variant: "destructive" });
      } else if (orders.length === 0) {
        toast({ title: data?.message || "未找到相關訂單" });
      } else {
        toast({ title: `找到 ${orders.length} 筆訂單` });
      }
    } catch (_e) { toast({ title: "查詢失敗", variant: "destructive" }); }
    finally { setOrderSearching(false); }
  };

  const loadProductPages = async () => {
    try {
      const res = await fetch("/api/orders/pages", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data.error) {
          toast({ title: data.message || "無法載入銷售頁", variant: "destructive" });
        }
        setProductPages(Array.isArray(data?.pages) ? data.pages : []);
      }
    } catch (_e) {
      toast({ title: "無法載入銷售頁列表", variant: "destructive" });
    }
  };

  const handleProductSearch = async () => {
    if (!selectedPageId || !productPhone.trim()) return;
    setOrderSearching(true);
    try {
      const params = new URLSearchParams({
        page_id: selectedPageId,
        phone: productPhone.trim(),
      });
      const res = await fetch(`/api/orders/by-product?${params}`, { credentials: "include" });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        toast({ title: errData?.message || "查詢失敗", variant: "destructive" });
        return;
      }
      const data = await res.json();
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      setOrderSearchResults(orders);
      if (selectedId && orders.length > 0) {
        for (const o of orders) {
          try {
            await fetch(`/api/contacts/${selectedId}/link-order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ order_id: o.global_order_id }),
            });
          } catch (_) {}
        }
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "linked-orders"] });
      }
      if (data.error) {
        toast({ title: data.message || "查詢失敗", variant: "destructive" });
      } else if (orders.length === 0) {
        toast({ title: data.message || "未找到相關訂單" });
      } else {
        toast({ title: `找到 ${orders.length} 筆訂單` });
      }
    } catch (_e) { toast({ title: "查詢失敗", variant: "destructive" }); }
    finally { setOrderSearching(false); }
  };

  const handleQuickReply = (text: string) => { setMessageInput(text); setShowQuickReplies(false); };

  const handleSendRating = useCallback(async (ratingType: "human" | "ai" = "human") => {
    if (!selectedId || sendingRating) return;
    if (ratingType === "ai" && selectedContact?.ai_rating != null) {
      toast({ title: "AI 評分已完成", description: "此客戶已完成 AI 客服滿意度評分", variant: "destructive" });
      return;
    }
    if (ratingType === "human" && selectedContact?.cs_rating != null) {
      toast({ title: "真人評分已完成", description: "此客戶已完成真人客服滿意度評分", variant: "destructive" });
      return;
    }
    setSendingRating(true);
    try {
      const res = await fetch(`/api/contacts/${selectedId}/send-rating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type: ratingType }),
      });
      const data = await res.json();
      if (res.ok) {
        const typeLabel = ratingType === "ai" ? "AI 客服" : "真人客服";
        toast({ title: "已發送評價卡片", description: `${typeLabel}滿意度調查已傳送給客戶` });
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
        invalidateContactsAndStats();
      } else {
        toast({ title: "發送失敗", description: data.message, variant: "destructive" });
      }
    } catch (_e) { toast({ title: "發送失敗", variant: "destructive" }); }
    finally { setSendingRating(false); }
  }, [selectedId, sendingRating, selectedContact, queryClient, toast, invalidateContactsAndStats]);

  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const addFiles = useCallback((files: FileList | File[]) => {
    const validFiles: { file: File; preview: string }[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        toast({ title: "不支援的檔案格式", description: `${file.name} — 僅支援 JPG, PNG, GIF, WebP`, variant: "destructive" });
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        toast({ title: "檔案太大", description: `${file.name} 超過 10MB 限制`, variant: "destructive" });
        continue;
      }
      validFiles.push({ file, preview: URL.createObjectURL(file) });
    }
    if ((validFiles ?? []).length > 0) setPendingFiles((prev) => [...(prev ?? []), ...validFiles]);
  }, [toast]);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const uploadAndSendFiles = useCallback(async () => {
    if ((pendingFiles ?? []).length === 0 || !selectedId || uploading) return;
    setUploading(true);
    try {
      for (const pf of pendingFiles) {
        const formData = new FormData();
        formData.append("file", pf.file);
        const uploadRes = await fetch("/api/chat-upload", { method: "POST", body: formData, credentials: "include" });
        if (!uploadRes.ok) {
          const err = await uploadRes.json();
          toast({ title: "上傳失敗", description: err.message || "無法上傳檔案", variant: "destructive" });
          continue;
        }
        const uploadData = await uploadRes.json();
        await apiRequest("POST", `/api/contacts/${selectedId}/messages`, {
          content: `[圖片] ${pf.file.name}`,
          message_type: "image",
          image_url: uploadData.url,
        });
        URL.revokeObjectURL(pf.preview);
      }
      setPendingFiles([]);
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
      invalidateContactsAndStats();
    } catch (_e) { toast({ title: "傳送失敗", variant: "destructive" }); }
    finally { setUploading(false); }
  }, [pendingFiles, selectedId, uploading, queryClient, toast, invalidateContactsAndStats]);

  const handleSendAll = useCallback(async () => {
    if (sending || uploading) return;
    if ((pendingFiles ?? []).length > 0) await uploadAndSendFiles();
    if (messageInput.trim()) await handleSendMessage();
  }, [pendingFiles, messageInput, sending, uploading, uploadAndSendFiles, handleSendMessage]);

  const getInitials = (name: string | undefined | null): string => (name != null && String(name).trim() ? String(name).trim().slice(0, 1).toUpperCase() : "?");
  const avatarColors = ["bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-sky-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];
  const contactTags = (() => {
    if (!selectedContact) return [];
    try {
      const v = JSON.parse(selectedContact.tags || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();
  const getStatusSemantic = (c: ContactWithPreview): keyof typeof STATUS_SEMANTIC => {
    if (["closed", "resolved"].includes(c.status)) return "muted";
    if (isUrgent(c) || (c as ContactWithPreview).reassign_count > 0) return "danger";
    if (!(c as ContactWithPreview).assigned_agent_name && c.needs_human) return "muted";
    if ((c as ContactWithPreview).assigned_agent_name) {
      if ((c as ContactWithPreview).last_message_sender_type === "user") return "warning";
      return "normal";
    }
    if (["awaiting_human", "pending", "new_case"].includes(c.status)) return "warning";
    return "assigned";
  };

  /** 列表用統一狀態：待分配 / 待我回覆(僅指分配給目前登入者) / 待回覆 / 等客戶回覆 / 處理中 / 已結案 */
  const getListStatusLabel = (c: ContactWithPreview, currentUserId?: number): string => {
    if (["closed", "resolved"].includes(c.status)) return "已結案";
    if (!c.assigned_agent_name && c.needs_human) return "待分配";
    if (c.assigned_agent_name && c.last_message_sender_type === "user") {
      return currentUserId != null && c.assigned_agent_id === currentUserId ? "待我回覆" : "待回覆";
    }
    if (c.assigned_agent_name && (c.last_message_sender_type === "admin" || c.last_message_sender_type === "ai")) return "等客戶回覆";
    if (c.assigned_agent_name) return "處理中";
    return "待分配";
  };

  /** 優先程度：高(1-2) / 中(3) / 低 */
  const getPriorityLabel = (c: ContactWithPreview): "高" | "中" | "低" | null => {
    const p = c.case_priority;
    if (p == null) return null;
    if (p <= 2) return "高";
    if (p <= 3) return "中";
    return "低";
  };

  return (
    <div className="flex h-full bg-[#faf9f5] relative" data-testid="chat-page">
      {!sseConnected && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-amber-500 text-white text-center text-sm py-2 px-4 flex items-center justify-center gap-3">
          <span>即時更新已中斷，新訊息可能不會自動出現</span>
          <button type="button" onClick={() => window.location.reload()} className="underline font-medium hover:no-underline">重新整理頁面</button>
        </div>
      )}
      <div className="w-[300px] min-w-[300px] border-r border-stone-200 flex flex-col bg-white">
        <div className="p-3 border-b border-stone-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <Input data-testid="input-search-contacts" placeholder="搜尋聯絡人或對話內容..." value={searchQuery} onChange={(e) => handleSearchChange(e.target.value)} className="pl-9 bg-stone-50 border-stone-200" />
            {searchQuery && (
              <button onClick={() => { setSearchQuery(""); setMessageSearchResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="w-3.5 h-3.5 text-stone-400 hover:text-stone-600" />
              </button>
            )}
          </div>
          {(isCsAgent || isManager) && (
            <div className="flex flex-wrap gap-1 mt-2">
              {(["all", "my", "pending", "high_risk", "tracking"] as ViewMode[]).map((vm) => (
                <button
                  key={vm}
                  onClick={() => setViewMode(vm)}
                  className={`text-[10px] font-medium py-2 px-2 rounded-lg transition-all border shrink-0 ${
                    viewMode === vm
                      ? "bg-stone-800 text-white border-stone-800 shadow-sm"
                      : "bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100"
                  }`}
                  data-testid={`button-view-${vm}`}
                >
                  {vm === "all" ? "全部" : vm === "my" ? "我的案件" : vm === "pending" ? "待我回覆" : vm === "high_risk" ? "緊急案件" : "待追蹤"}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1 mt-2">
            {(["all", "line", "messenger"] as const).map((pf) => (
              <button
                key={pf}
                onClick={() => setPlatformFilter(pf)}
                className={`flex-1 text-[10px] font-medium py-1 rounded-lg transition-all ${
                  platformFilter === pf
                    ? pf === "line" ? "bg-green-50 text-green-600 border border-green-200" : pf === "messenger" ? "bg-blue-50 text-blue-600 border border-blue-200" : "bg-emerald-50 text-emerald-600 border border-emerald-200"
                    : "text-stone-400 hover:bg-stone-50 border border-transparent"
                }`}
                data-testid={`button-filter-${pf}`}
              >
                {pf === "all" ? "全部" : pf === "line" ? "LINE" : "FB"}
              </button>
            ))}
          </div>
          {(isCsAgent || isManager) && (
            <p className="mt-2 text-[10px] text-stone-400 leading-tight">我的案件＝分配給我的；待我回覆＝輪到我回覆</p>
          )}
          {selectedBrandId != null && !dismissedBotIdHint && (
            <div className="mt-2 p-2 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2">
              <p className="text-[10px] text-amber-800 leading-tight flex-1">
                若 LINE 新訊息沒出現在此品牌：請先切到「全部」查看；若只在「全部」看到，請到 設定→品牌與渠道 將該 LINE 渠道的 Bot ID 改為 Railway 日誌中的 <code className="bg-amber-100 px-0.5 rounded">[WEBHOOK] destination</code> 值。
              </p>
              <button type="button" onClick={() => setDismissedBotIdHint(true)} className="text-amber-600 hover:text-amber-800 shrink-0 text-xs" aria-label="關閉提示">×</button>
            </div>
          )}
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          {contactsError ? (
            <div className="p-6 text-center text-sm text-red-600">無法載入聯絡人列表，請稍後再試</div>
          ) : contactsLoading && (contactsSafe.length === 0) ? (
            <div className="p-6 text-center text-sm text-stone-400">載入中...</div>
          ) : searchQuery.trim().length >= 2 && ((messageSearchResults ?? []).length > 0 || messageSearching) ? (
            <div className="p-2">
              {contactListSafe.length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-stone-400 uppercase tracking-wider">聯絡人</div>
                  {contactListSafe.slice(0, 5).map((contact) => (
                    <button key={contact.id} onClick={() => { setSelectedId(contact.id); lastMessageIdRef.current = 0; setSearchQuery(""); setMessageSearchResults([]); }}
                      className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl text-left transition-all hover:bg-stone-50`}
                      data-testid={`search-contact-${contact.id}`}
                    >
                      <Avatar className="w-8 h-8 shrink-0">
                        {contact.avatar_url && <AvatarImage src={contact.avatar_url} alt={contact.display_name} />}
                        <AvatarFallback className={`${getAvatarColor(contact.id)} text-white text-xs font-semibold`}>{getInitials(contact.display_name)}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium text-stone-700 truncate">{contact.display_name ?? ""}</span>
                    </button>
                  ))}
                </div>
              )}
              <div>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-stone-400 uppercase tracking-wider flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />對話紀錄 {messageSearching && <Loader2 className="w-3 h-3 animate-spin" />}
                </div>
                {(messageSearchResults ?? []).map((r) => (
                  <button key={r.message_id} onClick={() => { setSelectedId(r.contact_id); lastMessageIdRef.current = 0; setSearchQuery(""); setMessageSearchResults([]); }}
                    className="w-full flex items-start gap-2.5 p-2.5 rounded-xl text-left transition-all hover:bg-stone-50"
                    data-testid={`search-message-${r.message_id}`}
                  >
                    <div className="w-8 h-8 shrink-0 rounded-full bg-stone-100 flex items-center justify-center">
                      {r.sender_type === "user" ? <User className="w-3.5 h-3.5 text-stone-500" /> : r.sender_type === "ai" ? <Bot className="w-3.5 h-3.5 text-emerald-500" /> : <UserCheck className="w-3.5 h-3.5 text-blue-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className="text-xs font-semibold text-stone-700 truncate">{r.contact_name}</span>
                        <span className="text-[10px] text-stone-400 shrink-0">{r.created_at.substring(5, 16)}</span>
                      </div>
                      <p className="text-xs text-stone-500 line-clamp-2 leading-relaxed">{r.content}</p>
                    </div>
                  </button>
                ))}
                {(messageSearchResults ?? []).length === 0 && !messageSearching && (
                  <div className="px-3 py-2 text-xs text-stone-400">無符合的對話紀錄</div>
                )}
              </div>
            </div>
          ) : contactListSafe.length === 0 ? (
            <div className="p-6 text-center text-sm text-stone-400">
              {searchQuery ? "查無結果" : viewMode === "my" ? "目前沒有分配給你的案件" : viewMode === "pending" ? "目前沒有需要你回覆的案件" : viewMode === "high_risk" ? "目前沒有緊急案件" : viewMode === "tracking" ? "目前沒有待追蹤案件" : viewMode === "overdue" ? "目前沒有逾時未回案件" : viewMode === "unassigned" ? "目前沒有待分配案件" : "無聯絡人"}
            </div>
          ) : (
            <div ref={listScrollRef} className="flex-1 min-h-0 overflow-auto p-2">
              <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                {(rowVirtualizer.getVirtualItems() ?? []).map((virtualRow) => {
                  const contact = contactListSafe[virtualRow.index];
                  if (!contact) return null;
                  return (
                    <div
                      key={contact.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <ContactListItem
                        contact={contact}
                        isSelected={selectedId === contact.id}
                        currentUserId={authUser?.user?.id}
                        onSelect={handleSelectContact}
                        onPin={handleTogglePin}
                        onMouseEnter={prefetchMessagesForContact}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId || !selectedContact ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-stone-100 flex items-center justify-center">
                <MessageSquareEmpty className="w-10 h-10 text-stone-300" />
              </div>
              <h3 className="text-lg font-semibold text-stone-500">選擇一位聯絡人</h3>
              <p className="text-sm text-stone-400 mt-1">從左側列表選擇聯絡人開始對話</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-stone-200 bg-white">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="w-9 h-9 shrink-0">
                  {selectedContact?.avatar_url && <AvatarImage src={selectedContact.avatar_url} alt={selectedContact.display_name} />}
                  <AvatarFallback className={`${getAvatarColor(selectedContact?.id || 0)} text-white text-sm`}>{getInitials(selectedContact?.display_name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-bold text-stone-800 truncate" data-testid="text-selected-contact">{selectedContact?.display_name}</h3>
                    {selectedContact?.is_pinned ? <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 shrink-0" /> : null}
                    {selectedContact && selectedContact.vip_level > 0 && <VipBadge level={selectedContact.vip_level} />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Circle className={`w-2 h-2 ${selectedContact?.platform === "messenger" ? "fill-blue-500 text-blue-500" : "fill-emerald-500 text-emerald-500"}`} />
                    <span className="text-[11px] text-stone-400" data-testid="text-contact-platform">{selectedContact?.platform === "messenger" ? "Facebook Messenger" : "LINE"}</span>
                    {selectedContact?.brand_name && <span className="text-[11px] text-stone-400">| {selectedContact.brand_name}</span>}
                    {selectedContact && selectedContact.order_count > 0 && (
                      <span className="text-[11px] text-stone-400 ml-1">| {selectedContact.order_count} 筆訂單 · ${selectedContact.total_spent.toLocaleString()}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Select value={selectedContact?.status || "pending"} onValueChange={handleStatusChange}>
                  <SelectTrigger className="w-[130px] h-8 text-xs border-stone-200" data-testid="select-contact-status"><SelectValue placeholder="案件狀態" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel className="text-[10px] text-stone-400 font-normal">案件狀態</SelectLabel>
                      {CASE_STATUS_VALUES.map((s) => (
                        <SelectItem key={s} value={s} data-testid={`select-status-${s}`}>
                          <span className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${CONTACT_STATUS_COLORS[s].dot}`} />
                            {CONTACT_STATUS_LABELS[s]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel className="text-[10px] text-stone-400 font-normal">系統標記</SelectLabel>
                      {SYSTEM_MARK_VALUES.map((s) => (
                        <SelectItem key={s} value={s} data-testid={`select-status-${s}`}>
                          <span className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${CONTACT_STATUS_COLORS[s].dot}`} />
                            {CONTACT_STATUS_LABELS[s]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {isManager && selectedContact?.needs_human && selectedContact?.status === "awaiting_human" && (
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setShowAssignDialog(true)} data-testid="button-assign">
                    <UserCog className="w-3.5 h-3.5 mr-1" />分配
                  </Button>
                )}
                {isManager && selectedContact?.assigned_agent_id && (
                  <>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => setShowReassignDialog(true)} data-testid="button-reassign">
                      <Users className="w-3.5 h-3.5 mr-1" />改派
                    </Button>
                    <Button size="sm" variant="ghost" className="text-xs text-amber-600 hover:text-amber-700" onClick={handleUnassign} data-testid="button-unassign">
                      移回待分配
                    </Button>
                  </>
                )}
                {selectedContact?.assigned_agent_name ? (
                  <span className="text-[11px] font-medium text-stone-700 flex items-center gap-1.5">
                    <Avatar className="w-4 h-4 shrink-0">
                      {(selectedContact as ContactWithPreview).assigned_agent_avatar_url && <AvatarImage src={(selectedContact as ContactWithPreview).assigned_agent_avatar_url} alt={selectedContact.assigned_agent_name} />}
                      <AvatarFallback className="bg-violet-100 text-violet-700 text-[10px]">{getInitials(selectedContact?.assigned_agent_name)}</AvatarFallback>
                    </Avatar>
                    已分配：{selectedContact.assigned_agent_name}
                  </span>
                ) : selectedContact?.needs_human === 1 ? (
                  <span className="text-[11px] text-amber-600">待分配</span>
                ) : selectedContact?.status === "ai_handling" ? (
                  <span className="text-[11px] text-sky-600">AI處理中</span>
                ) : (() => {
                  const tags = JSON.parse(selectedContact?.tags || "[]");
                  return tags.includes("午休待處理") ? <span className="text-[11px] text-stone-500">午休待回覆</span> : null;
                })()}
                {selectedContact?.needs_human ? (
                  <Badge variant="destructive" className="gap-1 text-xs" data-testid="badge-human-mode"><Headphones className="w-3 h-3" />人工模式</Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs bg-stone-100 text-stone-600" data-testid="badge-ai-mode"><Bot className="w-3 h-3" />AI 模式</Badge>
                )}
                {selectedContact?.status === "awaiting_human" && (
                  <Badge variant="outline" className="gap-1 text-xs border-orange-300 bg-orange-50 text-orange-600" data-testid="badge-ai-muted">
                    <Circle className="w-2.5 h-2.5 fill-orange-400 text-orange-400" />AI 靜音中
                  </Badge>
                )}
                <Button size="sm" variant="outline" className="text-xs" onClick={() => setRightTab("orders")} data-testid="button-view-orders">
                  <ShoppingBag className="w-3.5 h-3.5 mr-1" />查看訂單
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" data-testid="button-copy-menu"><Copy className="w-3.5 h-3.5" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <DropdownMenuItem
                      onClick={() => {
                        const url = selectedId != null ? `${window.location.origin}${window.location.pathname}?contact=${selectedId}` : "";
                        if (url) navigator.clipboard.writeText(url).then(() => toast({ title: "已複製對話連結" }));
                      }}
                      data-testid="menu-copy-chat-link"
                    >
                      <Link2 className="w-3.5 h-3.5 mr-2" />複製對話連結
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        if (selectedId != null) {
                          const code = getConversationCode(selectedId);
                          navigator.clipboard.writeText(code).then(() => toast({ title: "已複製對話代碼" }));
                        }
                      }}
                      data-testid="menu-copy-chat-code"
                    >
                      <Copy className="w-3.5 h-3.5 mr-2" />複製對話代碼
                    </DropdownMenuItem>
                    {(linkedOrderIds ?? []).length > 0 && (
                      <>
                        <DropdownMenuItem
                          onClick={() => {
                            const oid = (linkedOrderIds ?? [])[0];
                            const url = `${window.location.origin}${window.location.pathname}?tab=orders&order=${encodeURIComponent(oid)}`;
                            navigator.clipboard.writeText(url).then(() => toast({ title: "已複製訂單連結" }));
                          }}
                          data-testid="menu-copy-order-link"
                        >
                          <Link2 className="w-3.5 h-3.5 mr-2" />複製訂單連結
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            navigator.clipboard.writeText((linkedOrderIds ?? [])[0] ?? "").then(() => toast({ title: "已複製訂單編號" }));
                          }}
                          data-testid="menu-copy-order-id"
                        >
                          <Copy className="w-3.5 h-3.5 mr-2" />複製訂單編號
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => {
                        if (selectedId != null) {
                          const code = getConversationCode(selectedId);
                          const url = `${window.location.origin}${window.location.pathname}?contact=${selectedId}`;
                          const text = `客服對話：${code}\n查看連結：${url}`;
                          navigator.clipboard.writeText(text).then(() => toast({ title: "已複製備註用格式" }));
                        }
                      }}
                      data-testid="menu-copy-note-format"
                    >
                      <Copy className="w-3.5 h-3.5 mr-2" />複製備註用格式
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {selectedContact?.needs_human ? (
                  <Button size="sm" variant="secondary"
                    onClick={() => selectedContact && handleRestoreAi(selectedContact.id)}
                    data-testid="button-restore-ai"
                    className="text-xs"
                  >
                    <Bot className="w-3.5 h-3.5 mr-1" />恢復 AI
                  </Button>
                ) : (
                  <div className="flex items-center gap-1">
                    <Select value={transferReason} onValueChange={setTransferReason}>
                      <SelectTrigger className="h-7 w-[120px] text-xs border-stone-200" data-testid="select-transfer-reason">
                        <SelectValue placeholder="轉接原因" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="管理員手動轉接">手動轉接</SelectItem>
                        <SelectItem value="客戶情緒激動">情緒激動</SelectItem>
                        <SelectItem value="退貨退款處理">退貨退款</SelectItem>
                        <SelectItem value="技術問題需專人">技術問題</SelectItem>
                        <SelectItem value="VIP 客戶優先">VIP 客戶</SelectItem>
                        <SelectItem value="AI 無法處理">AI 無法處理</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="default"
                      onClick={() => selectedContact && handleTransferHuman(selectedContact.id)}
                      data-testid="button-transfer-human"
                      className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <UserCheck className="w-3.5 h-3.5 mr-1" />轉人工
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-2.5 border-b border-stone-100 bg-[#faf9f5]/50 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Tag className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                {contactTags.map((tag) => (
                  <span key={tag} className={`inline-flex items-center gap-1.5 text-xs font-medium pl-2.5 pr-1 py-1 rounded-full border ${getTagColor(tag)}`}>
                    <span className="truncate max-w-[120px]">{tag}</span>
                    <button type="button" onClick={() => handleRemoveTag(tag)} className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/10 transition-colors" title="移除標籤" data-testid={`button-remove-tag-${tag}`}><X className="w-3 h-3" /></button>
                  </span>
                ))}
                <div className="flex items-center gap-1">
                  <Input data-testid="input-add-tag" placeholder="新增標籤..." value={newTag} onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                    className="h-7 w-28 text-xs bg-white border-stone-200 px-2" />
                  <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={handleAddTag} data-testid="button-add-tag"><Plus className="w-3.5 h-3.5" /></Button>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-stone-400 shrink-0">快速選取：</span>
                {shortcutTagNames
                  .filter((t, i, arr) => arr.indexOf(t) === i)
                  .filter((t) => !contactTags.includes(t))
                  .slice(0, 16)
                  .map((tag) => {
                    const isCustom = (apiTagShortcuts ?? []).length === 0 && (customTags ?? []).includes(tag);
                    return (
                      <span key={tag} className="inline-flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => handleAddTagWithValue(tag)}
                          className={`text-[11px] font-medium pl-2 pr-1.5 py-0.5 rounded-full border hover:opacity-90 ${getTagColor(tag)}`}
                          data-testid={`button-quick-tag-${tag}`}
                        >
                          +{tag}
                        </button>
                        {isCustom && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeCustomTag(tag); setCustomTags(getCustomTags()); }}
                            className="w-4 h-4 rounded-full flex items-center justify-center text-stone-400 hover:bg-stone-200 hover:text-stone-700"
                            title="從快捷列移除（本機）"
                            data-testid={`button-remove-quick-tag-${tag}`}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </span>
                    );
                  })}
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden relative"
              onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
              {isDragOver && (
                <div className="absolute inset-0 z-50 bg-emerald-50/90 border-2 border-dashed border-emerald-400 rounded-lg flex items-center justify-center pointer-events-none" data-testid="drag-overlay">
                  <div className="text-center">
                    <Upload className="w-12 h-12 text-emerald-500 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-emerald-700">將圖片拖曳至此以上傳</p>
                    <p className="text-xs text-emerald-500 mt-1">支援 JPG, PNG, GIF, WebP（最大 10MB）</p>
                  </div>
                </div>
              )}
              <div ref={chatViewportRef} className="flex-1 bg-[#faf9f5] overflow-y-auto">
                <div className="p-5">
                  {(messages?.length ?? 0) === 0 && messagesLoading ? (
                    <div className="text-center text-sm text-stone-400 py-8">載入訊息中...</div>
                  ) : (messages?.length ?? 0) === 0 ? (
                    <div className="text-center text-sm text-stone-400 py-8">尚無對話紀錄</div>
                  ) : (
                    <div className="space-y-4 max-w-2xl mx-auto">
                      {loadingOlder ? (
                        <div className="text-center text-xs text-stone-400 py-3 flex items-center justify-center gap-2" data-testid="loading-older">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>載入更早的訊息...</span>
                        </div>
                      ) : !hasMoreOlder && (displayMessages?.length ?? 0) > 0 ? (
                        <div className="text-center text-xs text-stone-400 py-2">已無更早的訊息</div>
                      ) : null}
                      {messagesFetching && !loadingOlder ? (
                        <div className="text-center text-xs text-stone-400 py-1">更新中...</div>
                      ) : null}
                      {displayMessages.map((msg, index) => {
                        if (msg == null || typeof msg !== "object" || msg.id == null) return <React.Fragment key={`msg-${index}`} />;
                        const prev = displayMessages[index - 1];
                        const showDate = index === 0 || !prev || formatDate(msg.created_at) !== formatDate(prev.created_at);
                        return (
                          <MessageBubble
                            key={msg.id}
                            msg={msg}
                            showDate={showDate}
                            onPreviewImage={setPreviewImage}
                          />
                        );
                      })}
                      {selectedId != null && streamingContent[selectedId] ? (
                        <MessageBubble
                          key="streaming"
                          msg={{
                            id: -1,
                            contact_id: selectedId,
                            platform: "line",
                            sender_type: "ai",
                            content: streamingContent[selectedId],
                            message_type: "text",
                            image_url: null,
                            created_at: new Date().toISOString(),
                          }}
                          showDate={false}
                          onPreviewImage={setPreviewImage}
                        />
                      ) : null}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>
              </div>

              <div className="w-[280px] min-w-[280px] border-l border-stone-200 bg-white flex flex-col" data-testid="panel-right">
                <Tabs value={rightTab} onValueChange={setRightTab} className="flex flex-col h-full">
                  <TabsList className="flex border-b border-stone-200 bg-white rounded-none px-2 pt-2 pb-0">
                    <TabsTrigger value="info" className="flex-1 text-xs rounded-t-lg rounded-b-none data-[state=active]:bg-stone-50 data-[state=active]:shadow-none" data-testid="tab-info">客戶資訊</TabsTrigger>
                    <TabsTrigger value="orders" className="flex-1 text-xs rounded-t-lg rounded-b-none data-[state=active]:bg-stone-50 data-[state=active]:shadow-none" data-testid="tab-orders">訂單查詢</TabsTrigger>
                  </TabsList>

                  <TabsContent value="info" className="flex-1 overflow-auto m-0">
                    <div className="p-3 space-y-3">
                      {/* 1. 案件總覽卡 */}
                      <Card className="border-stone-200 shadow-sm">
                        <CardHeader className="py-2 px-3">
                          <CardTitle className="text-xs font-semibold text-stone-600">案件總覽</CardTitle>
                        </CardHeader>
                        <CardContent className="px-3 pb-3 pt-0 space-y-1.5 text-[11px]">
                          <div className="flex justify-between"><span className="text-stone-500">狀態</span><span className="font-medium text-stone-700">{selectedContact?.status ? (CONTACT_STATUS_LABELS as Record<string, string>)[selectedContact.status] || selectedContact.status : "—"}</span></div>
                          <div className="flex justify-between"><span className="text-stone-500">優先級</span><span className={selectedContact && isUrgent(selectedContact) ? "text-red-600 font-medium" : "text-stone-700"}>{selectedContact && isUrgent(selectedContact) ? "緊急案件" : (selectedContact?.case_priority != null && selectedContact.case_priority <= 2 ? "優先處理" : "一般")}</span></div>
                          <div className="flex justify-between"><span className="text-stone-500">最後一句</span><span className="text-stone-700">{(selectedContact as ContactWithPreview)?.last_message_sender_type === "user" ? "客戶" : (selectedContact as ContactWithPreview)?.last_message_sender_type === "admin" ? "客服" : (selectedContact as ContactWithPreview)?.last_message_sender_type === "ai" ? "AI" : "—"}</span></div>
                          {selectedContact?.last_message_at && <div className="flex justify-between"><span className="text-stone-500">最後互動</span><span className="text-stone-700">{formatDateTime(selectedContact.last_message_at)}</span></div>}
                          {selectedContact && needReply(selectedContact) && isOverdue(selectedContact) && <div className="flex justify-between"><span className="text-stone-500">逾時</span><span className="text-red-600 font-medium">是</span></div>}
                          <div className="flex justify-between items-center"><span className="text-stone-500">問題類型</span><Select value={selectedContact?.issue_type || "none"} onValueChange={(v) => handleIssueTypeChange(v === "none" ? "" : v)}><SelectTrigger className="w-[100px] h-6 text-[10px] border-stone-200" data-testid="select-issue-type" /><SelectContent><SelectItem value="none">未分類</SelectItem>{(Object.keys(ISSUE_TYPE_LABELS) as IssueType[]).map((it) => <SelectItem key={it} value={it}>{ISSUE_TYPE_LABELS[it]}</SelectItem>)}</SelectContent></Select></div>
                        </CardContent>
                      </Card>

                      {/* 2. 負責人卡 */}
                      <Card className="border-stone-200 shadow-sm">
                        <CardHeader className="py-2 px-3">
                          <CardTitle className="text-xs font-semibold text-stone-600">負責人</CardTitle>
                        </CardHeader>
                        <CardContent className="px-3 pb-3 pt-0">
                          {(selectedContact?.assigned_agent_id ?? assignmentData?.assigned_to_user_id) ? (() => {
                            const assigneeId = selectedContact?.assigned_agent_id ?? assignmentData?.assigned_to_user_id;
                            const assigneeFromList = agentList.find((a) => a.id === assigneeId);
                            const name = selectedContact?.assigned_agent_name ?? assignmentData?.assigned_agent_name ?? "-";
                            const avatarUrl = selectedContact?.assigned_agent_avatar_url ?? assignmentData?.assigned_agent_avatar_url;
                            return (
                              <div className="flex items-center gap-2">
                                <Avatar className="w-10 h-10 shrink-0 ring-2 ring-white shadow-sm"><AvatarImage src={avatarUrl} alt={name} /><AvatarFallback className="bg-blue-100 text-blue-700 text-sm font-semibold">{name ? String(name).trim().slice(0, 1).toUpperCase() || "?" : "?"}</AvatarFallback></Avatar>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-stone-800 truncate">{name}</p>
                                  <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                                    <span className={assigneeFromList?.is_online === 1 ? "text-green-600" : "text-stone-400"}>{assigneeFromList?.is_online === 1 ? "在線" : "離線"}</span>
                                    {assigneeFromList && <span className="text-stone-500">{assigneeFromList.is_in_work ? "上班中" : "下班"}</span>}
                                    <span className="text-stone-500">負載 {assigneeFromList?.open_cases_count ?? 0}/{assigneeFromList?.max_active_conversations ?? 10}</span>
                                    <span className="text-stone-500">指派：{assignmentData?.assignment_method === "manual" ? "手動" : assignmentData?.assignment_method === "reassign" ? "改派" : "自動"}</span>
                                  </div>
                                </div>
                                {isManager && <Button size="sm" variant="outline" className="shrink-0 h-7 px-2 text-[10px]" onClick={() => setShowReassignDialog(true)} data-testid="button-change-assignee"><Pencil className="w-3 h-3 mr-0.5" />改派</Button>}
                              </div>
                            );
                          })() : (
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm text-stone-500">待分配</p>
                              {isManager && <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => setShowAssignDialog(true)} data-testid="button-assign-from-panel">指派</Button>}
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {/* 3. 案件屬性卡 */}
                      <Card className="border-stone-200 shadow-sm">
                        <CardHeader className="py-2 px-3">
                          <CardTitle className="text-xs font-semibold text-stone-600">案件屬性</CardTitle>
                        </CardHeader>
                        <CardContent className="px-3 pb-3 pt-0 space-y-1 text-[11px]">
                          <div className="flex justify-between"><span className="text-stone-500">平台</span><span className={`font-medium ${selectedContact?.platform === "messenger" ? "text-blue-600" : "text-green-600"}`} data-testid="text-info-platform">{selectedContact?.platform === "messenger" ? "FB" : "LINE"}</span></div>
                          {selectedContact?.brand_name && <div className="flex justify-between"><span className="text-stone-500">品牌</span><span className="text-stone-800 truncate max-w-[120px]" data-testid="text-info-brand">{selectedContact.brand_name}</span></div>}
                          {selectedContact?.channel_name && <div className="flex justify-between"><span className="text-stone-500">渠道</span><span className="text-stone-800 truncate max-w-[120px]" data-testid="text-info-channel">{selectedContact.channel_name}</span></div>}
                          <div className="flex justify-between"><span className="text-stone-500">平台 ID</span><span className="text-stone-600 font-mono text-[10px] truncate max-w-[100px]">{selectedContact?.platform_user_id}</span></div>
                          <div className="flex justify-between"><span className="text-stone-500">建立日期</span><span className="text-stone-700">{selectedContact?.created_at ? formatDate(selectedContact.created_at) : "—"}</span></div>
                          {assignmentData?.assignment_reason && <div className="flex justify-between"><span className="text-stone-500">轉人工原因</span><span className="text-stone-700 text-[10px] truncate max-w-[120px]">{assignmentData.assignment_reason}</span></div>}
                          {assignmentData?.response_sla_deadline_at && <div className="flex justify-between"><span className="text-stone-500">SLA 截止</span><span className="text-stone-700">{formatDateTime(assignmentData.response_sla_deadline_at)}</span></div>}
                        </CardContent>
                      </Card>

                      {/* 4. AI 建議卡 */}
                      {aiSuggestions && (aiSuggestions.issue_type || aiSuggestions.status || aiSuggestions.priority || (aiSuggestions.tags?.length)) ? (
                        <Card className="border-indigo-200 bg-indigo-50/30 shadow-sm">
                          <CardHeader className="py-2 px-3">
                            <CardTitle className="text-xs font-semibold text-indigo-800 flex items-center gap-1"><Bot className="w-3 h-3" /> AI 建議</CardTitle>
                          </CardHeader>
                          <CardContent className="px-3 pb-3 pt-0 space-y-1 text-[11px]">
                            {aiSuggestions.issue_type && <div className="flex justify-between"><span className="text-stone-500">建議問題類型</span><span className="text-indigo-700 font-medium">{(ISSUE_TYPE_LABELS as Record<string, string>)[aiSuggestions.issue_type] || aiSuggestions.issue_type}</span></div>}
                            {aiSuggestions.status && <div className="flex justify-between"><span className="text-stone-500">建議狀態</span><span className="text-indigo-700">{aiSuggestions.status}</span></div>}
                            {aiSuggestions.priority && <div className="flex justify-between"><span className="text-stone-500">建議優先級</span><span className="text-indigo-700">{aiSuggestions.priority}</span></div>}
                            {aiSuggestions.tags?.length ? <div className="flex flex-wrap gap-1 mt-1"><span className="text-stone-500 text-[10px] w-full">建議標籤</span>{aiSuggestions.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}</div> : null}
                          </CardContent>
                        </Card>
                      ) : null}

                      {isCsAgent && selectedContact && selectedContact.assigned_agent_id === authUser?.user?.id && (
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="sm" variant={(selectedContact as ContactWithPreview).my_flag === "later" ? "default" : "outline"} className="h-7 text-xs" onClick={() => handleSetAgentFlag(selectedContact.id, (selectedContact as ContactWithPreview).my_flag === "later" ? null : "later")} data-testid="button-flag-later">稍後處理</Button>
                          <Button size="sm" variant={(selectedContact as ContactWithPreview).my_flag === "tracking" ? "default" : "outline"} className="h-7 text-xs" onClick={() => handleSetAgentFlag(selectedContact.id, (selectedContact as ContactWithPreview).my_flag === "tracking" ? null : "tracking")} data-testid="button-flag-tracking">追蹤中</Button>
                          {(selectedContact as ContactWithPreview).my_flag && <Button size="sm" variant="ghost" className="h-7 text-xs text-stone-500" onClick={() => handleSetAgentFlag(selectedContact.id, null)}>清除</Button>}
                        </div>
                      )}

                      {(selectedContact?.ai_rating != null || selectedContact?.cs_rating != null) && (
                        <div className="space-y-1 text-[11px]">
                          {selectedContact?.ai_rating != null && <div className="flex justify-between text-indigo-600" data-testid="text-ai-rating"><span>AI 評分</span><span>{"⭐".repeat(selectedContact.ai_rating)}</span></div>}
                          {selectedContact?.cs_rating != null && <div className="flex justify-between text-amber-600" data-testid="text-cs-rating"><span>真人評分</span><span>{"⭐".repeat(selectedContact.cs_rating)}</span></div>}
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="orders" className="flex-1 overflow-auto m-0">
                    <div className="p-3 space-y-3">
                      <div className="flex items-center gap-1 mb-1 flex-wrap">
                        <button
                          onClick={() => { setSearchMode("simple"); setOrderSearchResults([]); }}
                          className={`text-[11px] px-2 py-1 rounded-md font-medium transition-colors ${searchMode === "simple" ? "bg-emerald-100 text-emerald-700" : "text-stone-400 hover:text-stone-600"}`}
                          data-testid="btn-search-mode-simple"
                        >
                          訂單編號
                        </button>
                        <button
                          onClick={() => { setSearchMode("product"); setOrderSearchResults([]); if ((productPages ?? []).length === 0) loadProductPages(); }}
                          className={`text-[11px] px-2 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${searchMode === "product" ? "bg-emerald-100 text-emerald-700" : "text-stone-400 hover:text-stone-600"}`}
                          data-testid="btn-search-mode-product"
                        >
                          <Package className="w-3 h-3" />商品+電話
                        </button>
                        <button
                          onClick={() => { setSearchMode("advanced"); setOrderSearchResults([]); }}
                          className={`text-[11px] px-2 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${searchMode === "advanced" ? "bg-emerald-100 text-emerald-700" : "text-stone-400 hover:text-stone-600"}`}
                          data-testid="btn-search-mode-advanced"
                        >
                          <Filter className="w-3 h-3" />日期+個資
                        </button>
                      </div>

                      {searchMode === "simple" ? (
                        <div className="flex gap-1.5">
                          <Input data-testid="input-order-search" placeholder="請輸入訂單編號（如 KBT...）" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleOrderSearch(); }}
                            className="text-xs bg-stone-50 border-stone-200 h-8" />
                          <Button size="sm" onClick={handleOrderSearch} disabled={orderSearching || !orderSearch.trim()} data-testid="button-search-order" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white shrink-0">
                            {orderSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                          </Button>
                        </div>
                      ) : searchMode === "product" ? (
                        <div className="space-y-2 p-2.5 rounded-lg bg-stone-50 border border-stone-200">
                          <div>
                            <label className="text-[10px] font-medium text-stone-500 mb-1 flex items-center gap-1"><Package className="w-3 h-3" />選擇商品（銷售頁）</label>
                            {selectedPageId && (() => {
                              const sel = productPages.find(p => p.pageId === selectedPageId);
                              return sel ? (
                                <div className="flex items-center justify-between text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded border border-emerald-200 mb-1" data-testid="text-selected-page">
                                  <span className="font-medium truncate">{sel.prefix ? `[${sel.prefix}] ` : ""}{sel.productName}</span>
                                  <button type="button" onClick={() => setSelectedPageId("")} className="ml-1 text-emerald-400 hover:text-red-500"><X className="w-3 h-3" /></button>
                                </div>
                              ) : null;
                            })()}
                            <Input
                              data-testid="input-page-search"
                              placeholder="輸入頁面名稱搜尋..."
                              value={pageSearchFilter}
                              onChange={(e) => setPageSearchFilter(e.target.value)}
                              className="text-xs bg-white border-stone-200 h-7 mb-1"
                            />
                            <div className="max-h-[180px] overflow-y-auto border border-stone-200 rounded-md bg-white">
                              {(productPages ?? []).length === 0 ? (
                                <div className="text-[10px] text-stone-400 p-2 text-center">載入中或無銷售頁...</div>
                              ) : (
                                productPages
                                  .filter(p => {
                                    if (!pageSearchFilter.trim()) return true;
                                    const q = pageSearchFilter.toLowerCase();
                                    return (p.productName?.toLowerCase().includes(q)) || (p.prefix?.toLowerCase().includes(q));
                                  })
                                  .map((p) => (
                                    <button
                                      key={p.pageId}
                                      type="button"
                                      onClick={() => { setSelectedPageId(p.pageId); setPageSearchFilter(""); }}
                                      className={`w-full text-left text-[11px] px-2 py-1.5 hover:bg-emerald-50 transition-colors border-b border-stone-100 last:border-0 ${selectedPageId === p.pageId ? "bg-emerald-50 text-emerald-700 font-medium" : "text-stone-700"}`}
                                      data-testid={`product-page-${p.pageId}`}
                                    >
                                      {p.prefix ? `[${p.prefix}] ` : ""}{p.productName}
                                    </button>
                                  ))
                              )}
                              {(productPages ?? []).length > 0 && pageSearchFilter.trim() && (productPages ?? []).filter(p => {
                                const q = pageSearchFilter.toLowerCase();
                                return (p.productName?.toLowerCase().includes(q)) || (p.prefix?.toLowerCase().includes(q));
                              }).length === 0 && (
                                <div className="text-[10px] text-stone-400 p-2 text-center">找不到符合「{pageSearchFilter}」的頁面</div>
                              )}
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] font-medium text-stone-500 mb-1 flex items-center gap-1"><Phone className="w-3 h-3" />客戶手機號碼</label>
                            <Input data-testid="input-product-phone" placeholder="例如：0912345678"
                              value={productPhone} onChange={(e) => setProductPhone(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleProductSearch(); }}
                              className="text-xs bg-white border-stone-200 h-8" />
                          </div>
                          <Button size="sm" onClick={handleProductSearch}
                            disabled={orderSearching || !selectedPageId || !productPhone.trim()}
                            data-testid="button-product-search"
                            className="w-full h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
                            {orderSearching ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />查詢中...</> : <><Search className="w-3.5 h-3.5 mr-1" />以商品+電話搜尋</>}
                          </Button>
                          <p className="text-[10px] text-stone-400 text-center">依銷售頁 (page_id) 限縮範圍，再比對電話</p>
                        </div>
                      ) : (
                        <div className="space-y-2 p-2.5 rounded-lg bg-stone-50 border border-stone-200">
                          <div>
                            <label className="text-[10px] font-medium text-stone-500 mb-1 block">電話 / Email / 姓名</label>
                            <Input data-testid="input-adv-query" placeholder="例如：0912345678 或 test@mail.com"
                              value={advSearchQuery} onChange={(e) => setAdvSearchQuery(e.target.value)}
                              className="text-xs bg-white border-stone-200 h-8" />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] font-medium text-stone-500 mb-1 flex items-center gap-1"><CalendarDays className="w-3 h-3" />開始日期</label>
                              <Input data-testid="input-adv-begin" type="date" value={advSearchBegin}
                                onChange={(e) => setAdvSearchBegin(e.target.value)}
                                className="text-xs bg-white border-stone-200 h-8" />
                            </div>
                            <div>
                              <label className="text-[10px] font-medium text-stone-500 mb-1 flex items-center gap-1"><CalendarDays className="w-3 h-3" />結束日期</label>
                              <Input data-testid="input-adv-end" type="date" value={advSearchEnd}
                                onChange={(e) => setAdvSearchEnd(e.target.value)}
                                className="text-xs bg-white border-stone-200 h-8" />
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            <div className="flex gap-1 flex-wrap">
                              {[
                                { label: "今天", fn: () => { const t = new Date().toISOString().slice(0, 10); setAdvSearchBegin(t); setAdvSearchEnd(t); } },
                                { label: "昨天", fn: () => { const d = new Date(); d.setDate(d.getDate() - 1); const t = d.toISOString().slice(0, 10); setAdvSearchBegin(t); setAdvSearchEnd(t); } },
                                { label: "近7天", fn: () => { const e = new Date(); const b = new Date(); b.setDate(b.getDate() - 6); setAdvSearchBegin(b.toISOString().slice(0, 10)); setAdvSearchEnd(e.toISOString().slice(0, 10)); } },
                                { label: "近30天", fn: () => { const e = new Date(); const b = new Date(); b.setDate(b.getDate() - 29); setAdvSearchBegin(b.toISOString().slice(0, 10)); setAdvSearchEnd(e.toISOString().slice(0, 10)); } },
                              ].map((preset) => (
                                <button key={preset.label} onClick={preset.fn}
                                  className="text-[10px] px-1.5 py-0.5 rounded border border-stone-200 text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition-colors"
                                  data-testid={`btn-preset-${preset.label}`}
                                >{preset.label}</button>
                              ))}
                            </div>
                          </div>
                          <Button size="sm" onClick={handleAdvancedSearch}
                            disabled={orderSearching || !advSearchQuery.trim() || !advSearchBegin || !advSearchEnd}
                            data-testid="button-adv-search"
                            className="w-full h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
                            {orderSearching ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />查詢中...</> : <><Search className="w-3.5 h-3.5 mr-1" />搜尋訂單</>}
                          </Button>
                          <p className="text-[10px] text-stone-400 text-center">日期範圍限 31 天內，搭配電話/Email/姓名過濾</p>
                        </div>
                      )}

                              {(orderSearchResults ?? []).length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-[10px] text-stone-400">查詢結果：{(orderSearchResults ?? []).length} 筆</p>
                          {(orderSearchResults ?? []).map((order, i) => {
                            const statusInfo = ORDER_STATUS_MAP[order.status] || { label: order.status, color: "bg-stone-50 text-stone-600 border-stone-200" };
                            const parsedProducts = parseProductList(order.product_list);
                            return (
                              <div key={i} className="rounded-xl border border-stone-200 p-3 space-y-2" data-testid={`order-card-${i}`}>
                                <div className="flex items-center justify-between gap-1 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-stone-800" data-testid={`order-id-${i}`}>{order.global_order_id}</span>
                                  <div className="flex items-center gap-1">
                                    {linkedContactsMap[order.global_order_id] != null ? (
                                      <a
                                        href={`?contact=${linkedContactsMap[order.global_order_id]}`}
                                        onClick={(e) => { e.preventDefault(); setSelectedId(linkedContactsMap[order.global_order_id]!); setRightTab("info"); }}
                                        className="text-[10px] font-medium text-emerald-600 hover:underline inline-flex items-center gap-0.5"
                                        data-testid={`order-view-chat-${i}`}
                                      >
                                        <MessageSquare className="w-3 h-3" />查看對話
                                      </a>
                                    ) : null}
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="複製訂單編號" onClick={() => { navigator.clipboard.writeText(order.global_order_id).then(() => toast({ title: "已複製訂單編號" })); }} data-testid={`order-copy-id-${i}`}>
                                      <Copy className="w-3 h-3" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="複製訂單連結" onClick={() => { const u = `${window.location.origin}${window.location.pathname}?tab=orders&order=${encodeURIComponent(order.global_order_id)}`; navigator.clipboard.writeText(u).then(() => toast({ title: "已複製訂單連結" })); }} data-testid={`order-copy-link-${i}`}>
                                      <Link2 className="w-3 h-3" />
                                    </Button>
                                    {order.source && order.source !== "unknown" && (
                                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${order.source === "shopline" ? "bg-indigo-100 text-indigo-700" : "bg-teal-100 text-teal-700"}`} data-testid={`order-source-${i}`}>
                                        {ORDER_SOURCE_LABELS[order.source as OrderSource] || order.source}
                                      </span>
                                    )}
                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusInfo.color}`}>{statusInfo.label}</span>
                                  </div>
                                </div>
                                <div className="text-xs text-stone-600 space-y-1">
                                  {order.buyer_name && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">收件人</span>
                                      <span>{order.buyer_name}</span>
                                    </div>
                                  )}
                                  {order.buyer_phone && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">電話</span>
                                      <span className="text-[11px]">{order.buyer_phone}</span>
                                    </div>
                                  )}
                                  {order.buyer_email && (
                                    <div className="flex justify-between items-start">
                                      <span className="text-stone-400 shrink-0">Email</span>
                                      <span className="text-[11px] text-right break-all">{order.buyer_email}</span>
                                    </div>
                                  )}
                                  <div className="flex justify-between">
                                    <span className="text-stone-400">金額</span>
                                    <span className="font-semibold text-stone-800">${order.final_total_order_amount.toLocaleString()}</span>
                                  </div>
                                  {order.shipping_method && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">配送方式</span>
                                      <span>{SHIPPING_METHOD_MAP[order.shipping_method] || order.shipping_method}</span>
                                    </div>
                                  )}
                                  {order.payment_method && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">付款方式</span>
                                      <span>{PAYMENT_METHOD_MAP[order.payment_method] || order.payment_method}</span>
                                    </div>
                                  )}
                                  {order.tracking_number && (
                                    <div className="flex justify-between items-start">
                                      <span className="text-stone-400 shrink-0">物流單號</span>
                                      <span className="font-mono text-[11px] text-emerald-700 cursor-pointer select-all text-right" title="點擊選取複製">{order.tracking_number}</span>
                                    </div>
                                  )}
                                  {order.order_created_at && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">下單時間</span>
                                      <span className="text-[11px]">{formatDateTime(order.order_created_at)}</span>
                                    </div>
                                  )}
                                  {order.shipped_at && (
                                    <div className="flex justify-between">
                                      <span className="text-stone-400">出貨時間</span>
                                      <span className="text-[11px] text-emerald-600">{formatDateTime(order.shipped_at)}</span>
                                    </div>
                                  )}
                                  {parsedProducts && (
                                    <div className="mt-1.5 pt-1.5 border-t border-stone-100">
                                      <span className="text-stone-400 text-[11px]">品項：</span>
                                      <p className="text-[11px] text-stone-700 mt-0.5 whitespace-pre-line">{parsedProducts}</p>
                                    </div>
                                  )}
                                  {order.address && (
                                    <div className="mt-1 pt-1 border-t border-stone-100">
                                      <span className="text-stone-400 text-[11px]">地址：</span>
                                      <p className="text-[11px] text-stone-700 mt-0.5">{order.address}</p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="text-center py-8">
                          <ShoppingBag className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                          <p className="text-xs text-stone-400">{searchMode === "product" ? "選擇商品並輸入電話" : searchMode === "advanced" ? "輸入條件並選擇日期範圍" : "輸入訂單編號查詢"}</p>
                          <p className="text-[11px] text-stone-400 mt-0.5">{searchMode === "product" ? "以銷售頁限縮範圍 + 電話比對" : searchMode === "advanced" ? "以電話/Email/姓名 + 日期限縮搜尋" : "請輸入訂單編號進行精準查詢"}</p>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>

            <div className="border-t border-stone-200 bg-white">
              {(pendingFiles ?? []).length > 0 && (
                <div className="px-4 pt-3 pb-1" data-testid="file-preview-area">
                  <div className="flex gap-2 flex-wrap max-w-2xl mx-auto">
                    {(pendingFiles ?? []).map((pf, i) => (
                      <div key={i} className="relative group" data-testid={`file-preview-${i}`}>
                        <img src={pf.preview} alt={pf.file.name} className="w-16 h-16 object-cover rounded-xl border border-stone-200 shadow-sm" />
                        <button onClick={() => removePendingFile(i)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm" data-testid={`button-remove-file-${i}`}>
                          <X className="w-3 h-3" />
                        </button>
                        <p className="text-[9px] text-stone-400 text-center mt-0.5 truncate w-16">{pf.file.name}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="p-4 pt-2">
                <div className="flex gap-2 max-w-2xl mx-auto items-center">
                  <div className="relative" ref={quickReplyRef}>
                    <Button size="icon" variant="ghost" className="h-10 w-10 text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                      onClick={() => setShowQuickReplies(!showQuickReplies)} data-testid="button-quick-reply">
                      <Zap className="w-5 h-5" />
                    </Button>
                    {showQuickReplies && (
                      <div className="absolute bottom-12 left-0 w-72 bg-white rounded-2xl shadow-lg border border-stone-200 py-2 z-50" data-testid="quick-reply-menu">
                        <p className="text-[11px] text-stone-400 px-3 pb-1.5 font-medium">快捷回覆</p>
                        {QUICK_REPLIES.map((text, i) => (
                          <button key={i} onClick={() => handleQuickReply(text)} className="w-full text-left px-3 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors" data-testid={`quick-reply-${i}`}>{text}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <input type="file" ref={fileInputRef} accept="image/jpeg,image/png,image/gif,image/webp" multiple onChange={handleFileSelect} className="hidden" data-testid="input-file-upload" />
                  <Button size="icon" variant="ghost" className="h-10 w-10 text-stone-400 hover:text-emerald-600 hover:bg-emerald-50" onClick={() => fileInputRef.current?.click()} data-testid="button-attach-file" title="附加圖片">
                    <Paperclip className="w-5 h-5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-10 w-10 text-stone-400 hover:text-stone-600 hover:bg-stone-100" data-testid="button-more-actions" title="更多操作">
                        <MoreHorizontal className="w-5 h-5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuItem
                        onClick={() => handleSendRating("ai")}
                        disabled={sendingRating || !selectedContact || selectedContact.platform !== "line" || selectedContact.ai_rating != null}
                        data-testid="button-send-ai-rating"
                      >
                        {selectedContact?.ai_rating != null ? "AI 評分已完成" : "發送 AI 評價卡片"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleSendRating("human")}
                        disabled={sendingRating || !selectedContact || selectedContact.platform !== "line" || selectedContact.cs_rating != null}
                        data-testid="button-send-rating"
                      >
                        {selectedContact?.cs_rating != null ? "真人評分已完成" : "發送真人評價卡片"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Input data-testid="input-message" placeholder="輸入訊息以真人客服身分回覆..." value={messageInput} onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendAll(); } }} disabled={sending || uploading} className="bg-stone-50 border-stone-200" />
                  <Button onClick={handleSendAll} disabled={(!messageInput.trim() && (pendingFiles ?? []).length === 0) || sending || uploading} data-testid="button-send-message" className="bg-emerald-600 hover:bg-emerald-700 text-white px-4">
                    {uploading ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />上傳中</> : <><Send className="w-4 h-4 mr-1.5" />傳送</>}
                  </Button>
                </div>
                <p className="text-[10px] text-stone-400 text-center mt-2">以管理員身分發送訊息 · 支援圖片拖曳上傳或點擊 📎 附件按鈕</p>
              </div>
            </div>
          </>
        )}
      </div>

      <Dialog open={showReassignDialog} onOpenChange={(open) => { setShowReassignDialog(open); if (!open) { setReassignAgentId(null); setReassignNote(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>改派客服</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-stone-700">指派給</label>
              <Select value={reassignAgentId != null ? String(reassignAgentId) : ""} onValueChange={(v) => setReassignAgentId(v ? parseInt(v, 10) : null)}>
                <SelectTrigger className="mt-1 border-stone-200">
                  <SelectValue placeholder="選擇客服（依處理量由少到多）" />
                </SelectTrigger>
                <SelectContent>
                  {agentListByLoad.map((a) => {
                    const isCurrent = a.id === (selectedContact?.assigned_agent_id ?? assignmentData?.assigned_to_user_id);
                    return (
                      <SelectItem key={a.id} value={String(a.id)}>
                        <span className="flex flex-col items-start gap-0.5">
                          <span className="flex items-center gap-2">
                            <Avatar className="w-5 h-5 shrink-0">
                              {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.display_name} />}
                              <AvatarFallback className="bg-stone-300 text-white text-[10px]">{a.display_name ? String(a.display_name).trim().slice(0, 1).toUpperCase() || "?" : "?"}</AvatarFallback>
                            </Avatar>
                            {a.display_name}
                            {isCurrent && <span className="text-[10px] text-amber-600">（目前負責）</span>}
                            {a.is_online === 1 ? <span className="text-[10px] text-emerald-600">在線</span> : <span className="text-[10px] text-stone-400">離線</span>}
                            {a.is_in_work ? <span className="text-[10px] text-stone-600">上班中</span> : <span className="text-[10px] text-stone-400">下班</span>}
                            <span className="text-[10px] text-stone-500">處理中 {a.open_cases_count ?? 0}/{a.max_active_conversations ?? 10}</span>
                          </span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {reassignAgentId != null && reassignAgentId === (selectedContact?.assigned_agent_id ?? assignmentData?.assigned_to_user_id) && (
                <p className="text-[11px] text-amber-600 mt-1">請選擇其他客服以完成改派</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-stone-700">備註（選填）</label>
              <Input value={reassignNote} onChange={(e) => setReassignNote(e.target.value)} placeholder="改派原因..." className="mt-1 border-stone-200" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReassignDialog(false)}>取消</Button>
            <Button
              onClick={handleReassignSubmit}
              disabled={reassignAgentId == null || reassigning || reassignAgentId === (selectedContact?.assigned_agent_id ?? assignmentData?.assigned_to_user_id)}
              data-testid="button-reassign-submit"
            >
              {reassigning ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}確認改派
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAssignDialog} onOpenChange={(open) => { setShowAssignDialog(open); if (!open) setAssignAgentId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>指派客服</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Button variant="outline" className="w-full justify-center border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60" onClick={handleAssign} disabled={assignAgentId != null} data-testid="button-assign-auto">
                自動分配（依負載與時段）
              </Button>
              {assignAgentId != null && (
                <p className="text-[11px] text-amber-600 mt-2 text-center font-medium">已選擇手動指定，請按下方「指派給選定客服」</p>
              )}
              <p className="text-[11px] text-stone-500 mt-2 text-center">或手動指定客服（不受在線/時段限制）</p>
              <p className="text-[11px] text-stone-500 mt-1 text-center">在線狀態依客服是否開啟「即時客服」頁面更新，可依「最後活動」時間確認</p>
            </div>
            <div>
              <label className="text-sm font-medium text-stone-700">指定給</label>
              <Select value={assignAgentId != null ? String(assignAgentId) : ""} onValueChange={(v) => setAssignAgentId(v ? parseInt(v, 10) : null)}>
                <SelectTrigger className="mt-1 border-stone-200">
                  <SelectValue placeholder="選擇客服（依處理量由少到多）" />
                </SelectTrigger>
                <SelectContent>
                  {agentListByLoad.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      <span className="flex flex-col items-start gap-0.5">
                        <span className="flex items-center gap-2">
                          <Avatar className="w-5 h-5 shrink-0">
                            {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.display_name} />}
                            <AvatarFallback className="bg-stone-300 text-white text-[10px]">{a.display_name ? String(a.display_name).trim().slice(0, 1).toUpperCase() || "?" : "?"}</AvatarFallback>
                          </Avatar>
                          {a.display_name}
                          {a.is_online === 1 ? <span className="text-[10px] text-emerald-600">在線</span> : <span className="text-[10px] text-stone-400">離線</span>}
                          {a.is_in_work ? <span className="text-[10px] text-stone-600">上班中</span> : <span className="text-[10px] text-stone-400">下班</span>}
                          <span className="text-[10px] text-stone-500">處理中 {a.open_cases_count ?? 0}/{a.max_active_conversations ?? 10}</span>
                        </span>
                        <span className="text-[10px] text-stone-500 ml-7">最後活動：{formatLastActive(a.last_active_at)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssignDialog(false)}>取消</Button>
            <Button
              onClick={() => {
                if (selectedId != null && assignAgentId != null) {
                  handleAssignToAgentWith(selectedId, assignAgentId);
                }
              }}
              disabled={assignAgentId == null || assigning}
              data-testid="button-assign-to-agent"
            >
              {assigning ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}指派給選定客服
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {previewImage && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setPreviewImage(null)} data-testid="image-lightbox">
          <button onClick={() => setPreviewImage(null)} className="absolute top-4 right-4 w-10 h-10 bg-white/20 hover:bg-white/30 rounded-full flex items-center justify-center transition-colors" data-testid="button-close-lightbox">
            <X className="w-6 h-6 text-white" />
          </button>
          <img src={previewImage} alt="預覽圖片" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

function MessageSquareEmpty({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h.01" /><path d="M12 10h.01" /><path d="M16 10h.01" />
    </svg>
  );
}
