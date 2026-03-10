import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getQueryFn } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useToast } from "@/hooks/use-toast";
import {
  Inbox,
  FileText,
  Link2,
  Loader2,
  EyeOff,
  UserCheck,
  Sparkles,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  FlaskConical,
  Send,
  MessageCircle,
  Shield,
  TestTube,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { MetaComment, MetaCommentTemplate, MetaPostMapping, MetaCommentRule, MetaPageSettings, MetaCommentRiskRule } from "@shared/schema";
import { META_COMMENT_INTENT_LABELS, META_COMMENT_CATEGORY_LABELS, META_COMMENT_STATUS_DISPLAY, META_COMMENT_INTENT_DISPLAY, META_REPLY_FLOW_DISPLAY } from "@shared/schema";

/** API 回傳的留言可能帶 brand_name（由後端 join） */
type MetaCommentWithBrand = MetaComment & { brand_name?: string | null };

/** Phase 3：主狀態顯示（與後端 main_status 一致） */
const MAIN_STATUS_DISPLAY: Record<string, string> = {
  unhandled: "未處理",
  pending_send: "待送出",
  auto_replied: "已自動回覆",
  human_replied: "已人工回覆",
  hidden: "已隱藏",
  routed_line: "已導 LINE",
  to_human: "待人工",
  completed: "已完成",
  failed: "執行失敗",
  partial_success: "部分成功",
  gray_area: "灰區待觀察",
  hidden_completed: "已隱藏完成",
};

/** 附加標籤 */
const TAG_LABELS: Record<string, string> = {
  general: "一般詢問",
  promotion: "導購",
  sensitive: "敏感",
  complaint: "客訴",
  no_mapping: "無 mapping",
  no_product: "未判定商品",
};

const STATUS_OPTIONS = [
  { value: "exceptions", label: "例外優先" },
  { value: "unhandled", label: "未處理" },
  { value: "failed", label: "執行失敗" },
  { value: "sensitive", label: "敏感／客訴" },
  { value: "to_human", label: "待人工" },
  { value: "overdue", label: "逾時" },
  { value: "no_product", label: "待補資料（商品）" },
  { value: "no_mapping", label: "待補資料（mapping）" },
  { value: "all", label: "全部" },
  { value: "completed", label: "已完成" },
  { value: "auto_replied", label: "已自動回覆" },
  { value: "hidden", label: "已隱藏" },
];

const SOURCE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "real", label: "僅真實" },
  { value: "simulated", label: "僅模擬" },
];

/** 安全解析 API 回傳，避免收到 HTML 時 JSON.parse 報 Unexpected token '<' */
async function parseJsonResponse<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype")) {
    console.error("[meta-comments] API 回傳了 HTML 而非 JSON，可能路徑錯誤或 fallback 到 SPA", res.url);
    throw new Error("伺服器回傳了網頁而非資料，請確認已啟動後端（npm run dev）並重新整理頁面");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text.slice(0, 200) || res.statusText);
  }
}

const RULE_TYPES: { value: MetaCommentRule["rule_type"]; label: string }[] = [
  { value: "use_template", label: "使用模板" },
  { value: "hide", label: "自動隱藏" },
  { value: "send_dm", label: "發送私訊" },
  { value: "to_human", label: "轉人工" },
  { value: "add_tag", label: "加標籤" },
];

function formatDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s.replace(" ", "T")).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return s;
  }
}

function commentStatusLabel(c: MetaComment & { main_status?: string | null }): string {
  const status = c.main_status;
  if (status && MAIN_STATUS_DISPLAY[status]) return MAIN_STATUS_DISPLAY[status];
  if (c.is_hidden) return "已隱藏";
  if (c.reply_error || c.hide_error) return "執行失敗";
  if (c.is_human_handled && c.replied_at) return "已人工回覆";
  if (c.is_human_handled) return "待人工";
  if (c.replied_at) return "已自動回覆";
  if ((c.reply_first ?? c.reply_second)?.trim()) return "待送出";
  return "未處理";
}

/** 品牌顯示：左側／右側一律有值，不可空白 */
function displayBrand(c: MetaComment & { brand_name?: string | null }): string {
  return (c as MetaCommentWithBrand).brand_name?.trim() || "未知品牌";
}

/** 導向結果一句話（例：導 KORENA 一般 LINE / 未判定商品） */
function routingSummary(c: MetaComment & { brand_name?: string | null }): string {
  const brand = displayBrand(c);
  if (c.is_hidden) return `已隱藏${c.target_line_type ? `｜導 ${brand} ${c.target_line_type === "after_sale" ? "售後" : "一般"} LINE` : ""}`;
  if (c.target_line_type && c.target_line_value) {
    const lineLabel = c.target_line_type === "after_sale" ? "售後 LINE" : "一般 LINE";
    return `導 ${brand} ${lineLabel}`;
  }
  const flow = (c as { reply_flow_type?: string | null }).reply_flow_type;
  if (flow === "product_link") return "導商品頁";
  if (flow === "line_redirect" || flow === "comfort_line") return "導 LINE（未指定）";
  if (!c.detected_product_name?.trim()) return "未判定商品";
  return "未導向";
}

/** 導向通道具體名稱 */
function channelDisplayName(c: MetaComment & { brand_name?: string | null }): string {
  const brand = displayBrand(c);
  if (c.target_line_type && c.target_line_value) {
    return c.target_line_type === "after_sale" ? `${brand} 售後 LINE` : `${brand} 一般 LINE`;
  }
  const flow = (c as { reply_flow_type?: string | null }).reply_flow_type;
  if (flow === "product_link") return "商品頁";
  if (flow === "activity_link") return "活動頁";
  if (flow === "line_redirect" || flow === "comfort_line") return `${brand} LINE（未指定連結）`;
  if (!c.detected_product_name?.trim()) return "未判定商品";
  return "人工判讀";
}

/** 導向原因（供導向通道區塊顯示） */
function routingReasonLabel(c: MetaComment): string {
  if (c.is_human_handled === 1) return "因人工改派";
  if (c.reply_link_source === "post_mapping") return "因商品 mapping";
  if (c.classifier_source === "rule" && (c.priority === "urgent" || ["complaint", "refund_after_sale"].includes(c.ai_intent || ""))) return "因敏感件規則";
  if (c.reply_link_source === "page_default") return "因粉專預設";
  if (c.reply_link_source === "manual_template" || c.applied_rule_id != null) return "因規則／手動";
  if (!c.detected_product_name?.trim()) return "因商品未判定，暫時人工";
  return "因人工判讀";
}

/** 左側卡片：微型處理摘要（一行讓客服不點進去也知道進度） */
function miniProgressSummary(c: MetaComment & { brand_name?: string | null }): string {
  const parts: string[] = [];
  if (c.reply_error) parts.push("回覆失敗");
  else if (c.replied_at) parts.push("已回覆");
  else if ((c.reply_first ?? c.reply_second)?.trim()) parts.push("回覆未送出");
  else parts.push("回覆未送出");
  if (c.hide_error) parts.push("隱藏失敗");
  else if (c.is_hidden === 1) parts.push("已隱藏");
  else parts.push("隱藏未執行");
  if (c.target_line_type && c.target_line_value) parts.push(`導${c.target_line_type === "after_sale" ? "售後" : "一般"} LINE`);
  if (c.is_human_handled === 1) parts.push("待人工");
  return parts.join("｜");
}

/** 是否為待補資料（未知品牌／未判定商品／無 mapping → 前台醒目顯示） */
function isPendingData(c: MetaComment & { brand_name?: string | null }): boolean {
  const noBrand = !(c as MetaCommentWithBrand).brand_name?.trim() || (c as MetaCommentWithBrand).brand_name === "未知品牌";
  const noProduct = !(c.detected_product_name || c.post_display_name)?.trim();
  const noMapping = c.reply_link_source === "none" || c.reply_link_source == null;
  return noBrand || noProduct || noMapping;
}

/** 顯示用：待補資料時用「待補資料」語意 */
function productOrPending(c: MetaComment): string {
  const v = (c.detected_product_name || c.post_display_name)?.trim();
  return v ? v : "待補資料（未判定商品）";
}

function brandOrPending(c: MetaComment & { brand_name?: string | null }): string {
  const v = (c as MetaCommentWithBrand).brand_name?.trim();
  if (v && v !== "未知品牌") return v;
  return "待補資料（品牌）";
}

/** 左側卡片警示類型（高風險／待人工／失敗／逾時 → 不同視覺） */
function cardAlert(c: MetaComment & { main_status?: string | null }, defaultReplyMinutes = 30): "high_risk" | "to_human" | "failed" | "overdue" | null {
  const status = c.main_status;
  if (status === "failed" || status === "partial_success" || c.reply_error || c.hide_error) return "failed";
  if (status === "to_human" || c.is_human_handled === 1) return "to_human";
  if (c.priority === "urgent" || (c.ai_suggest_human ?? 0) === 1 || ["complaint", "refund_after_sale"].includes(c.ai_intent || "")) return "high_risk";
  const pending = !c.replied_at && c.is_hidden !== 1 && status !== "completed";
  if (pending && c.created_at) {
    const created = new Date(c.created_at).getTime();
    if (Date.now() - created > defaultReplyMinutes * 60 * 1000) return "overdue";
  }
  return null;
}

/** 留言類型（卡片第一行用） */
function commentTypeLabel(c: MetaComment): string {
  if (["complaint", "refund_after_sale"].includes(c.ai_intent || "")) return "客訴";
  if (c.priority === "urgent" || (c.ai_suggest_human ?? 0) === 1) return "敏感";
  return META_COMMENT_INTENT_DISPLAY[c.ai_intent || ""] || META_COMMENT_INTENT_LABELS[c.ai_intent || ""] || "一般詢問";
}

function isHighRisk(c: MetaComment): boolean {
  return (c.ai_suggest_human ?? 0) !== 0 || c.priority === "urgent" || ["complaint", "refund_after_sale"].includes(c.ai_intent || "");
}

/** 分流結果顯示（若 DB 無 reply_flow_type 則由欄位推導） */
function replyFlowLabel(c: MetaComment): string {
  const flow = (c as { reply_flow_type?: string | null }).reply_flow_type;
  if (flow && META_REPLY_FLOW_DISPLAY[flow]) return META_REPLY_FLOW_DISPLAY[flow];
  if (!c.reply_second?.trim() && (c.priority === "urgent" || (c.ai_suggest_human ?? 0) === 1)) return META_REPLY_FLOW_DISPLAY.comfort_line;
  if (c.reply_second?.trim() && c.reply_link_source === "post_mapping") return META_REPLY_FLOW_DISPLAY.product_link;
  if (c.reply_second?.trim()) return META_REPLY_FLOW_DISPLAY.line_redirect;
  return META_REPLY_FLOW_DISPLAY.public_only;
}

const VALID_TABS = ["inbox", "rules", "mapping", "page-settings", "risk-rules", "simulate"] as const;

/** P0-A: path segment -> 顯示用名稱、document.title 用 */
const COMMENT_CENTER_PAGE_TITLES: Record<string, string> = {
  inbox: "留言收件匣",
  rules: "留言規則與導向",
  "channel-binding": "粉專與 LINE 設定",
  simulate: "內測模擬",
  "batch-pages": "粉專批次串接",
};

const RISK_BUCKET_LABELS: Record<string, string> = {
  whitelist: "白名單",
  direct_hide: "直接隱藏",
  hide_and_route: "隱藏 + 導 LINE",
  route_only: "只導 LINE",
  gray_area: "灰區觀察",
};

function ruleActionSummary(r: MetaCommentRiskRule): string {
  const parts: string[] = [];
  if (r.action_reply) parts.push("回覆");
  if (r.action_hide) parts.push("隱藏");
  if (r.action_route_line) parts.push(r.route_line_type === "after_sale" ? "導售後 LINE" : "導一般 LINE");
  if (r.action_mark_to_human) parts.push("待人工");
  if (parts.length === 0) {
    if (r.rule_bucket === "whitelist") return "白名單豁免";
    if (r.rule_bucket === "direct_hide") return "直接隱藏";
    if (r.rule_bucket === "gray_area") return "灰區觀察";
    if (r.rule_bucket === "hide_and_route") return "安撫+隱藏+導LINE";
    if (r.rule_bucket === "route_only") return "只導 LINE";
  }
  return parts.join(" + ") || "—";
}

const COMMENT_CENTER_VALID_TABS = ["inbox", "rules", "channel-binding", "simulate", "batch-pages"] as const;

/** P0-A: 從 pathname 解析目前子頁（inbox | rules | channel-binding | simulate） */
function useCommentCenterPage(): string {
  const [location] = useLocation();
  const pathname = typeof location === "string" ? location : (location as { pathname?: string })?.pathname ?? "";
  const segment = (pathname.replace(/^\/comment-center\/?/, "").split("/")[0] || "").toLowerCase();
  return COMMENT_CENTER_VALID_TABS.includes(segment as any) ? segment : "inbox";
}

export default function CommentCenterPage() {
  const [location, setLocation] = useLocation();
  const currentPage = useCommentCenterPage();
  /** P0-A: 僅在 rules 頁使用，用於規則／模板對應／風險導流三區切換 */
  const [rulesSubTab, setRulesSubTab] = useState<"rules" | "mapping" | "risk-rules">("rules");
  const activeMainTab = currentPage === "rules" ? rulesSubTab : currentPage === "channel-binding" ? "page-settings" : currentPage === "inbox" ? "inbox" : currentPage === "simulate" ? "simulate" : currentPage === "batch-pages" ? "batch-pages" : "inbox";

  useEffect(() => {
    const pathname = typeof location === "string" ? location : (location as { pathname?: string })?.pathname ?? "";
    const segment = (pathname.replace(/^\/comment-center\/?/, "").split("/")[0] || "").toLowerCase();
    if (segment && !COMMENT_CENTER_VALID_TABS.includes(segment as any)) {
      setLocation("/comment-center/inbox");
    }
  }, [location, setLocation]);

  const { data: authData } = useQuery<{ user?: { role: string } } | null>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });
  const isSuperAdmin = authData?.user?.role === "super_admin";

  const { data: brandsList = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/brands"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: currentPage === "batch-pages",
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [currentPage]);

  useEffect(() => {
    const title = COMMENT_CENTER_PAGE_TITLES[currentPage] || "留言中心";
    document.title = `${title} | AI 客服中控台`;
    return () => { document.title = "AI 客服中控台"; };
  }, [currentPage]);

  const [inboxStatus, setInboxStatus] = useState<string>("exceptions");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [editFirst, setEditFirst] = useState("");
  const [editSecond, setEditSecond] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleType, setRuleType] = useState<MetaCommentRule["rule_type"]>("use_template");
  const [rulePriority, setRulePriority] = useState(0);
  const [ruleTemplateId, setRuleTemplateId] = useState<string>("");
  const [ruleTagValue, setRuleTagValue] = useState("");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [tplCategory, setTplCategory] = useState("product_inquiry");
  const [tplName, setTplName] = useState("");
  const [tplFirst, setTplFirst] = useState("");
  const [tplSecond, setTplSecond] = useState("");
  const [tplComfort, setTplComfort] = useState("");
  const [tplDmGuide, setTplDmGuide] = useState("");
  const [tplTone, setTplTone] = useState("");
  const [editingMappingId, setEditingMappingId] = useState<number | null>(null);
  const [mapPostId, setMapPostId] = useState("");
  const [mapPostName, setMapPostName] = useState("");
  const [mapPageId, setMapPageId] = useState("");
  const [mapPageName, setMapPageName] = useState("");
  const [mapProductName, setMapProductName] = useState("");
  const [mapPrimaryUrl, setMapPrimaryUrl] = useState("");
  const [mapFallbackUrl, setMapFallbackUrl] = useState("");
  const [mapTone, setMapTone] = useState("");
  const [mapAutoEnabled, setMapAutoEnabled] = useState(true);
  const [mapPreferredFlow, setMapPreferredFlow] = useState<string>("product_link");
  const [simPageId, setSimPageId] = useState("page_demo");
  const [simPageName, setSimPageName] = useState("示範粉專");
  const [simPostId, setSimPostId] = useState("post_001");
  const [simPostName, setSimPostName] = useState("測試貼文");
  const [simCommenterName, setSimCommenterName] = useState("模擬用戶");
  const [simMessage, setSimMessage] = useState("");
  const [simWebhookJson, setSimWebhookJson] = useState("");
  const [seedLoading, setSeedLoading] = useState(false);
  const [inboxSource, setInboxSource] = useState<"all" | "real" | "simulated">("all");
  const [metaBatchToken, setMetaBatchToken] = useState("");
  const [metaBatchPages, setMetaBatchPages] = useState<{ page_id: string; page_name: string; access_token: string }[]>([]);
  const [metaBatchSelected, setMetaBatchSelected] = useState<Set<string>>(new Set());
  const [metaBatchBrandId, setMetaBatchBrandId] = useState<string>("");
  const [metaBatchLoading, setMetaBatchLoading] = useState(false);
  const [metaBatchImporting, setMetaBatchImporting] = useState(false);
  const [replying, setReplying] = useState(false);
  const { selectedBrandId } = useBrand();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: comments = [], isLoading: commentsLoading } = useQuery<MetaCommentWithBrand[]>({
    queryKey: ["/api/meta-comments", selectedBrandId ?? "all", inboxStatus, inboxSource],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId) params.set("brand_id", String(selectedBrandId));
      if (inboxStatus !== "all") params.set("status", inboxStatus);
      if (inboxSource !== "all") params.set("source", inboxSource);
      if (inboxStatus === "exceptions") params.set("archive_delay_minutes", "5");
      const res = await fetch(`/api/meta-comments?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: currentPage === "inbox",
  });

  const { data: assignableAgents = [] } = useQuery<{ id: number; display_name: string; avatar_url: string | null }[]>({
    queryKey: ["/api/meta-comments/assignable-agents"],
    queryFn: async () => {
      const res = await fetch("/api/meta-comments/assignable-agents", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "inbox",
  });

  const { data: selectedComment } = useQuery<MetaCommentWithBrand | null>({
    queryKey: ["/api/meta-comments", selectedId],
    queryFn: async () => {
      if (!selectedId) return null;
      const res = await fetch(`/api/meta-comments/${selectedId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: currentPage === "inbox" && !!selectedId,
  });

  const { data: templates = [] } = useQuery<MetaCommentTemplate[]>({
    queryKey: ["/api/meta-comment-templates", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comment-templates?brand_id=${selectedBrandId}` : "/api/meta-comment-templates";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: currentPage === "rules",
  });

  const [mappingSearch, setMappingSearch] = useState("");
  const [mapProductSearch, setMapProductSearch] = useState("");

  const { data: metaPages = [] } = useQuery<{ page_id: string; page_name: string }[]>({
    queryKey: ["/api/meta-pages", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-pages?brand_id=${selectedBrandId}` : "/api/meta-pages";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "rules" || currentPage === "channel-binding",
  });
  const { data: metaPostsByPage = [] } = useQuery<{ post_id: string; post_name: string }[]>({
    queryKey: ["/api/meta-pages", mapPageId || "none", "posts"],
    queryFn: async () => {
      if (!mapPageId) return [];
      const res = await fetch(`/api/meta-pages/${encodeURIComponent(mapPageId)}/posts${selectedBrandId ? `?brand_id=${selectedBrandId}` : ""}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "rules" && !!mapPageId,
  });
  const { data: metaProducts = [] } = useQuery<{ product_name: string }[]>({
    queryKey: ["/api/meta-products", selectedBrandId, mapProductSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId) params.set("brand_id", String(selectedBrandId));
      if (mapProductSearch.trim()) params.set("q", mapProductSearch.trim());
      const res = await fetch(`/api/meta-products?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "rules",
  });

  const { data: mappings = [] } = useQuery<MetaPostMapping[]>({
    queryKey: ["/api/meta-post-mappings", selectedBrandId, mappingSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId) params.set("brand_id", String(selectedBrandId));
      if (mappingSearch.trim()) params.set("q", mappingSearch.trim());
      const res = await fetch(`/api/meta-post-mappings?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: currentPage === "rules",
  });

  const { data: rules = [] } = useQuery<MetaCommentRule[]>({
    queryKey: ["/api/meta-comment-rules", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comment-rules?brand_id=${selectedBrandId}` : "/api/meta-comment-rules";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: currentPage === "rules",
  });

  type PageSettingsRow = MetaPageSettings & { brand_name?: string };
  const { data: pageSettingsList = [] } = useQuery<PageSettingsRow[]>({
    queryKey: ["/api/meta-page-settings", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-page-settings?brand_id=${selectedBrandId}` : "/api/meta-page-settings";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "channel-binding",
  });

  const { data: commentSummary } = useQuery<{ unhandled: number; sensitive: number; to_human: number; failed: number; completed: number; overdue: number; exceptions: number; default_reply_minutes: number }>({
    queryKey: ["/api/meta-comments/summary", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comments/summary?brand_id=${selectedBrandId}` : "/api/meta-comments/summary";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { unhandled: 0, sensitive: 0, to_human: 0, failed: 0, completed: 0, overdue: 0, exceptions: 0, default_reply_minutes: 30 };
      return res.json();
    },
    refetchInterval: 60000,
    enabled: currentPage === "inbox",
  });

  const { data: health } = useQuery<{
    today_total: number; today_auto_completed: number; today_to_human: number; today_failed: number;
    today_hidden?: number; today_routed_general?: number; today_routed_after_sale?: number;
    avg_processing_minutes: number | null; last_1h_total: number; last_1h_success: number; last_1h_success_rate: number | null;
    alert_active: boolean; alert_reason: string | null;
    today_rule_hit_distribution?: { whitelist: number; direct_hide: number; hide_and_route: number; route_only: number; gray_area: number; general_ai: number };
    today_completion_distribution?: { ai_replied: number; hidden_completed: number; routed_line: number; to_human: number; failed: number; gray_area: number };
    recent_error_reasons?: { reason: string; count: number }[];
  }>({
    queryKey: ["/api/meta-comments/health", selectedBrandId],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comments/health?brand_id=${selectedBrandId}` : "/api/meta-comments/health";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { today_total: 0, today_auto_completed: 0, today_to_human: 0, today_failed: 0, avg_processing_minutes: null, last_1h_total: 0, last_1h_success: 0, last_1h_success_rate: null, alert_active: false, alert_reason: null, today_rule_hit_distribution: { whitelist: 0, direct_hide: 0, hide_and_route: 0, route_only: 0, gray_area: 0, general_ai: 0 }, today_completion_distribution: { ai_replied: 0, hidden_completed: 0, routed_line: 0, to_human: 0, failed: 0, gray_area: 0 }, recent_error_reasons: [] };
      return res.json();
    },
    refetchInterval: 30000,
    enabled: currentPage === "inbox",
  });

  const [showCompletedSection, setShowCompletedSection] = useState(false);
  const [showSpotCheck, setShowSpotCheck] = useState(false);
  const [showGraySpotCheck, setShowGraySpotCheck] = useState(false);
  const { data: spotCheckComments = [], isLoading: spotCheckLoading } = useQuery<MetaCommentWithBrand[]>({
    queryKey: ["/api/meta-comments/spot-check", selectedBrandId, showSpotCheck],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comments/spot-check?brand_id=${selectedBrandId}&limit=20` : "/api/meta-comments/spot-check?limit=20";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "inbox" && showSpotCheck,
  });
  const { data: graySpotCheckComments = [], isLoading: graySpotCheckLoading } = useQuery<MetaCommentWithBrand[]>({
    queryKey: ["/api/meta-comments/gray-spot-check", selectedBrandId, showGraySpotCheck],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/meta-comments/gray-spot-check?brand_id=${selectedBrandId}&limit=20` : "/api/meta-comments/gray-spot-check?limit=20";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "inbox" && showGraySpotCheck,
  });

  const { data: completedComments = [], isLoading: completedLoading } = useQuery<MetaCommentWithBrand[]>({
    queryKey: ["/api/meta-comments", selectedBrandId ?? "all", "completed", "list", showCompletedSection],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId) params.set("brand_id", String(selectedBrandId));
      params.set("status", "completed");
      const res = await fetch(`/api/meta-comments?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      const list = await res.json();
      return (list as MetaCommentWithBrand[]).slice(0, 50);
    },
    enabled: currentPage === "inbox" && showCompletedSection,
  });

  const [riskRuleSearchQ, setRiskRuleSearchQ] = useState("");
  const [riskRuleFilterBucket, setRiskRuleFilterBucket] = useState<string>("all");
  const [riskRuleFilterEnabled, setRiskRuleFilterEnabled] = useState<string>("all");
  const { data: riskRulesList = [], refetch: refetchRiskRules } = useQuery<MetaCommentRiskRule[]>({
    queryKey: ["/api/meta-comment-risk-rules", selectedBrandId, riskRuleSearchQ, riskRuleFilterBucket, riskRuleFilterEnabled],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrandId != null) params.set("brand_id", String(selectedBrandId));
      if (riskRuleSearchQ.trim()) params.set("q", riskRuleSearchQ.trim());
      if (riskRuleFilterBucket && riskRuleFilterBucket !== "all") params.set("bucket", riskRuleFilterBucket);
      if (riskRuleFilterEnabled === "1") params.set("enabled", "1");
      if (riskRuleFilterEnabled === "0") params.set("enabled", "0");
      const url = `/api/meta-comment-risk-rules?${params.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: currentPage === "rules",
  });
  const [ruleTestMessage, setRuleTestMessage] = useState("");
  const [ruleTestPageId, setRuleTestPageId] = useState("");
  const [ruleTestResult, setRuleTestResult] = useState<{
    matches: { rule_id: number; rule_bucket: string; keyword_pattern: string; priority: number; rule_name: string }[];
    final: { matched_rule_bucket?: string; matched_keyword?: string; action_reply?: boolean; action_hide?: boolean; action_route_line?: boolean; action_mark_to_human?: boolean; route_line_type?: string | null } | null;
    reason: string;
    decisionSummary?: string;
    target_line_display?: string;
    brand_id?: number | null;
    page_id?: string | null;
  } | null>(null);
  const [ruleTestLoading, setRuleTestLoading] = useState(false);
  const [editingRiskRuleId, setEditingRiskRuleId] = useState<number | null>(null);
  const [riskRuleForm, setRiskRuleForm] = useState<Partial<MetaCommentRiskRule> | null>(null);
  const { data: editingRiskRule } = useQuery<MetaCommentRiskRule | null>({
    queryKey: ["/api/meta-comment-risk-rules", editingRiskRuleId],
    queryFn: async () => {
      if (!editingRiskRuleId || editingRiskRuleId <= 0) return null;
      const res = await fetch(`/api/meta-comment-risk-rules/${editingRiskRuleId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: currentPage === "rules" && editingRiskRuleId != null && editingRiskRuleId > 0,
  });
  useEffect(() => {
    if (editingRiskRuleId != null && editingRiskRuleId > 0 && editingRiskRule) setRiskRuleForm({ ...editingRiskRule });
  }, [editingRiskRuleId, editingRiskRule]);

  useEffect(() => {
    if (selectedComment) {
      setEditFirst(selectedComment.reply_first ?? "");
      setEditSecond(selectedComment.reply_second ?? "");
    } else {
      setEditFirst("");
      setEditSecond("");
    }
  }, [selectedComment]);

  useEffect(() => {
    if (editingRuleId != null) {
      const r = rules.find((x) => x.id === editingRuleId);
      if (r) {
        setRuleKeyword(r.keyword_pattern);
        setRuleType(r.rule_type);
        setRulePriority(r.priority);
        setRuleTemplateId(r.template_id != null ? String(r.template_id) : "");
        setRuleTagValue(r.tag_value ?? "");
        setRuleEnabled(r.enabled !== 0);
      }
    } else {
      setRuleKeyword("");
      setRuleType("use_template");
      setRulePriority(0);
      setRuleTemplateId("");
      setRuleTagValue("");
      setRuleEnabled(true);
    }
  }, [editingRuleId, rules]);

  useEffect(() => {
    if (editingTemplateId != null) {
      const t = templates.find((x) => x.id === editingTemplateId);
      if (t) {
        setTplCategory(t.category);
        setTplName(t.name);
        setTplFirst(t.reply_first);
        setTplSecond(t.reply_second);
        setTplComfort(t.reply_comfort);
        setTplDmGuide(t.reply_dm_guide);
        setTplTone(t.tone_hint ?? "");
      }
    } else {
      setTplCategory("product_inquiry");
      setTplName("");
      setTplFirst("");
      setTplSecond("");
      setTplComfort("");
      setTplDmGuide("");
      setTplTone("");
    }
  }, [editingTemplateId, templates]);

  useEffect(() => {
    if (editingMappingId != null) {
      const m = mappings.find((x) => x.id === editingMappingId);
      if (m) {
        setMapPostId(m.post_id);
        setMapPostName(m.post_name ?? "");
        setMapPageId(m.page_id ?? "");
        setMapPageName(m.page_name ?? "");
        setMapProductName(m.product_name ?? "");
        setMapPrimaryUrl(m.primary_url ?? "");
        setMapFallbackUrl(m.fallback_url ?? "");
        setMapTone(m.tone_hint ?? "");
        setMapAutoEnabled(m.auto_comment_enabled !== 0);
        setMapPreferredFlow((m as { preferred_flow?: string }).preferred_flow || "product_link");
      }
    } else {
      setMapPostId("");
      setMapPostName("");
      setMapPageId("");
      setMapPageName("");
      setMapProductName("");
      setMapPrimaryUrl("");
      setMapFallbackUrl("");
      setMapTone("");
      setMapAutoEnabled(true);
      setMapPreferredFlow("product_link");
    }
  }, [editingMappingId, mappings]);

  const handleSuggestReply = async () => {
    if (!selectedId) return;
    setSuggesting(true);
    try {
      const res = await fetch(`/api/meta-comments/${selectedId}/suggest-reply`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || res.statusText);
      }
      const updated = await res.json() as MetaComment;
      setEditFirst(updated.reply_first ?? "");
      setEditSecond(updated.reply_second ?? "");
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已產生建議回覆" });
    } catch (e: any) {
      toast({ title: "產生失敗", description: e?.message, variant: "destructive" });
    } finally {
      setSuggesting(false);
    }
  };

  const handleMarkReplied = async () => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/meta-comments/${selectedId}`, { replied_at: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已標記為已回覆" });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleMarkHidden = async () => {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/meta-comments/${selectedId}/hide`, { method: "POST", credentials: "include" });
      const data = await parseJsonResponse<{ message?: string }>(res);
      if (!res.ok) throw new Error(data?.message || res.statusText);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/summary"] });
      toast({ title: "已隱藏留言（已同步至 Facebook）" });
    } catch (e: any) {
      toast({ title: "隱藏失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleToHuman = async () => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/meta-comments/${selectedId}`, { is_human_handled: 1 });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/summary"] });
      toast({ title: "已轉人工處理" });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleAssign = async (agentId: number, agentName?: string, agentAvatarUrl?: string | null) => {
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/meta-comments/${selectedId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          agent_id: agentId,
          agent_name: agentName ?? assignableAgents.find((a) => a.id === agentId)?.display_name,
          agent_avatar_url: agentAvatarUrl ?? assignableAgents.find((a) => a.id === agentId)?.avatar_url,
        }),
      });
      if (!res.ok) {
        const data = await parseJsonResponse<{ message?: string }>(res);
        throw new Error(data?.message || res.statusText);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已指派負責人" });
    } catch (e: any) {
      toast({ title: "指派失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleUnassign = async () => {
    if (!selectedId) return;
    try {
      await apiRequest("POST", `/api/meta-comments/${selectedId}/unassign`);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已移回待分配" });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleSaveReply = async () => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/meta-comments/${selectedId}`, { reply_first: editFirst || null, reply_second: editSecond || null });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已儲存回覆" });
    } catch {
      toast({ title: "儲存失敗", variant: "destructive" });
    }
  };

  /** 立即公開回覆：將目前編輯區內容送到 Facebook */
  const handleReplyNow = async () => {
    if (!selectedId) return;
    const msg = [editFirst?.trim(), editSecond?.trim()].filter(Boolean).join("\n\n");
    if (!msg) {
      toast({ title: "請先填寫回覆內容", variant: "destructive" });
      return;
    }
    setReplying(true);
    try {
      const res = await fetch(`/api/meta-comments/${selectedId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: msg }),
      });
      const data = await parseJsonResponse<{ message?: string }>(res);
      if (!res.ok) throw new Error(data?.message || res.statusText);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/summary"] });
      toast({ title: "已送出公開回覆" });
    } catch (e: any) {
      toast({ title: "送出失敗", description: e?.message, variant: "destructive" });
    } finally {
      setReplying(false);
    }
  };

  /** 標記已完成（已回覆＋人工處理完成） */
  const handleMarkCompleted = async () => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/meta-comments/${selectedId}`, {
        replied_at: new Date().toISOString(),
        is_human_handled: 1,
        main_status: "completed",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/summary"] });
      toast({ title: "已標記為已完成" });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  /** 複製導流連結／開啟 LINE 連結 */
  const handleCopyOrOpenLine = (url: string) => {
    if (!url?.trim()) {
      toast({ title: "尚無導向連結", variant: "destructive" });
      return;
    }
    try {
      navigator.clipboard.writeText(url);
      toast({ title: "已複製導流連結" });
    } catch {
      window.open(url, "_blank");
    }
  };

  const handleRuleSubmit = async () => {
    if (!ruleKeyword.trim()) {
      toast({ title: "請輸入關鍵字", variant: "destructive" });
      return;
    }
    try {
      if (editingRuleId != null) {
        await apiRequest("PUT", `/api/meta-comment-rules/${editingRuleId}`, {
          keyword_pattern: ruleKeyword.trim(),
          rule_type: ruleType,
          priority: rulePriority,
          template_id: ruleTemplateId ? parseInt(ruleTemplateId) : null,
          tag_value: ruleTagValue.trim() || null,
          enabled: ruleEnabled ? 1 : 0,
        });
        toast({ title: "已更新規則" });
        setEditingRuleId(null);
      } else {
        await apiRequest("POST", "/api/meta-comment-rules", {
          brand_id: selectedBrandId ?? null,
          keyword_pattern: ruleKeyword.trim(),
          rule_type: ruleType,
          priority: rulePriority,
          template_id: ruleTemplateId ? parseInt(ruleTemplateId) : null,
          tag_value: ruleTagValue.trim() || null,
          enabled: ruleEnabled ? 1 : 0,
        });
        toast({ title: "已新增規則" });
        setRuleKeyword("");
        setRuleType("use_template");
        setRulePriority(0);
        setRuleTemplateId("");
        setRuleTagValue("");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comment-rules"] });
    } catch (e: any) {
      toast({ title: "操作失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleRuleToggleEnabled = async (r: MetaCommentRule) => {
    try {
      const newVal = r.enabled !== 0 ? 0 : 1;
      await apiRequest("PUT", `/api/meta-comment-rules/${r.id}`, { enabled: newVal });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comment-rules"] });
      toast({ title: newVal ? "已啟用規則" : "已停用規則" });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleTemplateSubmit = async () => {
    if (!tplName.trim()) {
      toast({ title: "請輸入模板名稱", variant: "destructive" });
      return;
    }
    try {
      if (editingTemplateId != null) {
        await apiRequest("PUT", `/api/meta-comment-templates/${editingTemplateId}`, {
          category: tplCategory,
          name: tplName.trim(),
          reply_first: tplFirst,
          reply_second: tplSecond,
          reply_comfort: tplComfort,
          reply_dm_guide: tplDmGuide,
          tone_hint: tplTone.trim() || null,
        });
        toast({ title: "已更新模板" });
        setEditingTemplateId(null);
      } else {
        await apiRequest("POST", "/api/meta-comment-templates", {
          brand_id: selectedBrandId ?? null,
          category: tplCategory,
          name: tplName.trim(),
          reply_first: tplFirst,
          reply_second: tplSecond,
          reply_comfort: tplComfort,
          reply_dm_guide: tplDmGuide,
          tone_hint: tplTone.trim() || null,
        });
        toast({ title: "已新增模板" });
        setTplName("");
        setTplFirst("");
        setTplSecond("");
        setTplComfort("");
        setTplDmGuide("");
        setTplTone("");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comment-templates"] });
    } catch (e: any) {
      toast({ title: "操作失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleMappingSubmit = async () => {
    if (!mapPostId.trim()) {
      toast({ title: "請輸入貼文 ID", variant: "destructive" });
      return;
    }
    if (!selectedBrandId && !editingMappingId) {
      toast({ title: "請先選擇品牌（貼文對應需指定品牌）", variant: "destructive" });
      return;
    }
    const brandId = selectedBrandId ?? (editingMappingId != null ? mappings.find((m) => m.id === editingMappingId)?.brand_id : undefined);
    if (!brandId) {
      toast({ title: "無法取得品牌，請先選擇品牌", variant: "destructive" });
      return;
    }
    try {
      if (editingMappingId != null) {
        await apiRequest("PUT", `/api/meta-post-mappings/${editingMappingId}`, {
          post_id: mapPostId.trim(),
          post_name: mapPostName.trim() || null,
          page_id: mapPageId.trim() || null,
          page_name: mapPageName.trim() || null,
          product_name: mapProductName.trim() || null,
          primary_url: mapPrimaryUrl.trim() || null,
          fallback_url: mapFallbackUrl.trim() || null,
          tone_hint: mapTone.trim() || null,
          auto_comment_enabled: mapAutoEnabled ? 1 : 0,
          preferred_flow: mapPreferredFlow || null,
        });
        toast({ title: "已更新對應" });
        setEditingMappingId(null);
      } else {
        await apiRequest("POST", "/api/meta-post-mappings", {
          brand_id: brandId,
          post_id: mapPostId.trim(),
          post_name: mapPostName.trim() || null,
          page_id: mapPageId.trim() || null,
          page_name: mapPageName.trim() || null,
          product_name: mapProductName.trim() || null,
          primary_url: mapPrimaryUrl.trim() || null,
          fallback_url: mapFallbackUrl.trim() || null,
          tone_hint: mapTone.trim() || null,
          auto_comment_enabled: mapAutoEnabled ? 1 : 0,
          preferred_flow: mapPreferredFlow || null,
        });
        toast({ title: "已新增對應" });
        setMapPostId("");
        setMapPostName("");
        setMapPageId("");
        setMapPageName("");
        setMapProductName("");
        setMapPrimaryUrl("");
        setMapFallbackUrl("");
        setMapTone("");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/meta-post-mappings"] });
    } catch (e: any) {
      toast({ title: "操作失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleTestMapping = async (mappingId: number) => {
    try {
      const res = await fetch("/api/meta-comments/test-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mapping_id: mappingId }),
      });
      if (!res.ok) {
        const data = await parseJsonResponse<{ message?: string }>(res);
        throw new Error(data?.message || res.statusText);
      }
      const comment = await parseJsonResponse<MetaComment>(res);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      setSelectedId(comment.id);
      setInboxSource("all");
      toast({ title: "已建立測試留言，請至收件匣點選並「產生建議回覆」驗證連結" });
    } catch (e: any) {
      toast({ title: "測試失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleCreateSimulatedComment = async () => {
    if (!simMessage.trim()) {
      toast({ title: "請輸入留言內容", variant: "destructive" });
      return;
    }
    try {
      const row = await apiRequest("POST", "/api/meta-comments", {
        brand_id: selectedBrandId ?? null,
        page_id: simPageId.trim() || "page_demo",
        page_name: simPageName.trim() || null,
        post_id: simPostId.trim() || "post_001",
        post_name: simPostName.trim() || null,
        commenter_name: simCommenterName.trim() || "模擬用戶",
        message: simMessage.trim(),
        is_simulated: 1,
      }).then((r) => r.json()) as MetaComment;
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      setSelectedId(row.id);
      setSimMessage("");
      toast({ title: "已建立模擬留言，請至收件匣查看" });
    } catch (e: any) {
      toast({ title: "建立失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleSimulateWebhook = async () => {
    const payload = simWebhookJson.trim()
      ? (() => {
          try {
            return JSON.parse(simWebhookJson) as Record<string, unknown>;
          } catch {
            toast({ title: "JSON 格式錯誤", variant: "destructive" });
            return null;
          }
        })()
      : {
          message: simMessage || "(空)",
          commenter_name: simCommenterName || "模擬用戶",
          post_id: simPostId || "post_001",
          page_id: simPageId || "page_demo",
          page_name: simPageName,
          post_name: simPostName,
          brand_id: selectedBrandId ?? undefined,
        };
    if (payload == null) return;
    try {
      const res = await fetch("/api/meta-comments/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const row = await parseJsonResponse<MetaComment>(res);
      if (!res.ok) throw new Error((row as any)?.message || res.statusText);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      setSelectedId((row as MetaComment).id);
      toast({ title: "已模擬 Webhook 並建立留言" });
    } catch (e: any) {
      toast({ title: "模擬失敗", description: e?.message, variant: "destructive" });
    }
  };

  const handleSeedTestCases = async () => {
    setSeedLoading(true);
    try {
      const res = await fetch("/api/meta-comments/seed-test-cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          brand_id: selectedBrandId ?? null,
          page_id: simPageId || "page_demo",
          page_name: simPageName || "示範粉專",
          post_id: simPostId || "post_001",
          post_name: simPostName || "測試貼文",
        }),
      });
      const data = await parseJsonResponse<{ created?: number; ids?: number[]; message?: string }>(res);
      if (!res.ok) throw new Error(data?.message || res.statusText);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      if (data.ids?.length) setSelectedId(data.ids[0]);
      toast({ title: `已建立 ${data.created ?? 0} 筆測試留言` });
    } catch (e: any) {
      toast({ title: "建立失敗", description: e?.message, variant: "destructive" });
    } finally {
      setSeedLoading(false);
    }
  };

  const fetchMetaBatchPages = async () => {
    if (!metaBatchToken.trim()) {
      toast({ title: "請貼上 Meta User Access Token", variant: "destructive" });
      return;
    }
    setMetaBatchLoading(true);
    try {
      const res = await fetch("/api/meta/batch/available-pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ user_access_token: metaBatchToken.trim() }),
      });
      const data = await parseJsonResponse<{ pages?: { page_id: string; page_name: string; access_token: string }[]; message?: string }>(res);
      if (!res.ok) throw new Error(data?.message || res.statusText);
      setMetaBatchPages(data.pages || []);
      setMetaBatchSelected(new Set());
      toast({ title: `已取得 ${data.pages?.length ?? 0} 個粉專` });
    } catch (e: any) {
      toast({ title: "取得粉專列表失敗", description: e?.message, variant: "destructive" });
    } finally {
      setMetaBatchLoading(false);
    }
  };

  const doMetaBatchImport = async () => {
    const bid = metaBatchBrandId ? parseInt(metaBatchBrandId, 10) : 0;
    if (!bid || !brandsList.some((b) => b.id === bid)) {
      toast({ title: "請選擇品牌", variant: "destructive" });
      return;
    }
    const selected = metaBatchPages.filter((p) => metaBatchSelected.has(p.page_id));
    if (selected.length === 0) {
      toast({ title: "請至少勾選一個粉專", variant: "destructive" });
      return;
    }
    setMetaBatchImporting(true);
    try {
      const res = await fetch("/api/meta/batch/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          brand_id: bid,
          pages: selected.map((p) => ({ page_id: p.page_id, page_name: p.page_name, access_token: p.access_token })),
        }),
      });
      const data = await parseJsonResponse<{ results?: { page_id: string; page_name: string; error?: string }[] }>(res);
      if (!res.ok) throw new Error((data as any)?.message || res.statusText);
      const results = (data.results || []) as { page_id: string; page_name: string; error?: string }[];
      const ok = results.filter((r) => !r.error).length;
      const fail = results.filter((r) => r.error).length;
      queryClient.invalidateQueries({ queryKey: ["/api/meta-page-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      toast({ title: `匯入完成：成功 ${ok}，略過/失敗 ${fail}` });
      if (ok > 0) {
        setMetaBatchPages((prev) => prev.filter((p) => results.some((r) => r.page_id === p.page_id && r.error)));
        setMetaBatchSelected(new Set());
      }
    } catch (e: any) {
      toast({ title: "匯入失敗", description: e?.message, variant: "destructive" });
    } finally {
      setMetaBatchImporting(false);
    }
  };

  const handleApplyTemplateAndSave = async (t: MetaCommentTemplate) => {
    if (!selectedId) return;
    const first = t.reply_first || "";
    const second = t.reply_second || "";
    try {
      await apiRequest("PUT", `/api/meta-comments/${selectedId}`, {
        reply_first: first || null,
        reply_second: second || null,
        applied_template_id: t.id,
        reply_link_source: "manual_template",
      });
      setEditFirst(first);
      setEditSecond(second);
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
      toast({ title: "已套用並儲存模板" });
    } catch {
      toast({ title: "套用失敗", variant: "destructive" });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-stone-800">AI 自動處理監控台</h1>
        <p className="text-sm text-stone-500 mt-0.5">預設只看例外，需處理的再進來 — 分流、導流、安撫、標記</p>
      </div>

      {health?.alert_active && health.alert_reason && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800 text-sm font-medium flex items-center gap-2">
          <span className="shrink-0">⚠ 失敗告警</span>
          <span>{health.alert_reason}</span>
        </div>
      )}
      {health?.recent_error_reasons && health.recent_error_reasons.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 text-sm">
          <p className="font-medium mb-2">最近主要錯誤原因（近 10 分鐘）</p>
          <ul className="list-disc list-inside space-y-0.5 text-xs">
            {health.recent_error_reasons.slice(0, 5).map((e, i) => (
              <li key={i}><span className="font-mono truncate max-w-[80%] inline-block align-bottom" title={e.reason}>{e.reason}</span> <span className="text-amber-700">×{e.count}</span></li>
            ))}
          </ul>
        </div>
      )}

      {/* P0-A: 依 path 的頁內導航（與 sidebar 一致，每頁一個主任務） */}
      <nav className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg mb-4" aria-label="留言中心頁面">
        <Link href="/comment-center/inbox" className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentPage === "inbox" ? "bg-white shadow-sm text-stone-900" : "text-stone-600 hover:bg-stone-200"}`}>
          <Inbox className="w-4 h-4" />
          留言收件匣
        </Link>
        <Link href="/comment-center/rules" className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentPage === "rules" ? "bg-white shadow-sm text-stone-900" : "text-stone-600 hover:bg-stone-200"}`}>
          <FileText className="w-4 h-4" />
          留言規則與導向
        </Link>
        <Link href="/comment-center/channel-binding" className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentPage === "channel-binding" ? "bg-white shadow-sm text-stone-900" : "text-stone-600 hover:bg-stone-200"}`}>
          <MessageCircle className="w-4 h-4" />
          粉專與 LINE 設定
        </Link>
        <Link href="/comment-center/simulate" className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentPage === "simulate" ? "bg-white shadow-sm text-stone-900" : "text-stone-600 hover:bg-stone-200"}`}>
          <FlaskConical className="w-4 h-4" />
          內測模擬
        </Link>
        {isSuperAdmin && (
          <Link href="/comment-center/batch-pages" className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${currentPage === "batch-pages" ? "bg-white shadow-sm text-stone-900" : "text-stone-600 hover:bg-stone-200"}`}>
            <Plus className="w-4 h-4" />
            粉專批次串接
          </Link>
        )}
      </nav>

      <Tabs value={activeMainTab} onValueChange={(v) => { if (currentPage === "rules") setRulesSubTab(v as "rules" | "mapping" | "risk-rules"); }} className="space-y-4">
        {currentPage === "rules" && (
          <TabsList className="bg-stone-100 p-1 flex flex-wrap h-auto gap-1 mb-4">
            <TabsTrigger value="rules" className="data-[state=active]:bg-white data-[state=active]:shadow-sm shrink-0">
              <FileText className="w-4 h-4 mr-2" />
              自動規則
            </TabsTrigger>
            <TabsTrigger value="mapping" className="data-[state=active]:bg-white data-[state=active]:shadow-sm shrink-0">
              <Link2 className="w-4 h-4 mr-2" />
              模板與商品對應
            </TabsTrigger>
            <TabsTrigger value="risk-rules" className="data-[state=active]:bg-white data-[state=active]:shadow-sm shrink-0">
              <Shield className="w-4 h-4 mr-2" />
              留言風險與導流規則
            </TabsTrigger>
          </TabsList>
        )}

        <TabsContent value="inbox" className="space-y-4 mt-4">
          {health != null && (
            <>
              <div className="rounded-lg border border-stone-200 bg-white px-4 py-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-3 text-sm">
                <div><span className="text-stone-500">今日總留言</span><p className="font-semibold text-stone-800">{health.today_total}</p></div>
                <div><span className="text-stone-500">自動完成</span><p className="font-semibold text-green-700">{health.today_auto_completed}{health.today_total > 0 ? ` (${Math.round((health.today_auto_completed / health.today_total) * 100)}%)` : ""}</p></div>
                <div><span className="text-stone-500">待人工</span><p className="font-semibold text-blue-600">{health.today_to_human}</p></div>
                <div><span className="text-stone-500">執行失敗</span><p className="font-semibold text-red-600">{health.today_failed}</p></div>
                <div><span className="text-stone-500">今日隱藏</span><p className="font-semibold text-amber-700">{health.today_hidden ?? 0}</p></div>
                <div><span className="text-stone-500">今日導 LINE</span><p className="font-semibold text-stone-700">{health.today_routed_general ?? 0} 一般 / {health.today_routed_after_sale ?? 0} 售後</p></div>
                <div><span className="text-stone-500">平均處理</span><p className="font-semibold text-stone-700">{health.avg_processing_minutes != null ? `${health.avg_processing_minutes} 分` : "—"}</p></div>
                <div><span className="text-stone-500">近 1h 成功率</span><p className="font-semibold text-stone-700">{health.last_1h_success_rate != null ? `${health.last_1h_success_rate}%` : "—"}</p></div>
              </div>
              {(health.today_rule_hit_distribution || health.today_completion_distribution) && (
                <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  {health.today_rule_hit_distribution && (
                    <div>
                      <p className="text-stone-600 font-medium mb-1">今日規則命中分布</p>
                      <p className="text-stone-700 text-xs">白名單 {health.today_rule_hit_distribution.whitelist} · 直接隱藏 {health.today_rule_hit_distribution.direct_hide} · 隱藏+導LINE {health.today_rule_hit_distribution.hide_and_route} · 只導LINE {health.today_rule_hit_distribution.route_only} · 灰區 {health.today_rule_hit_distribution.gray_area} · 一般 AI {health.today_rule_hit_distribution.general_ai}</p>
                    </div>
                  )}
                  {health.today_completion_distribution && (
                    <div>
                      <p className="text-stone-600 font-medium mb-1">今日完成類型分布</p>
                      <p className="text-stone-700 text-xs">AI 公開回覆 {health.today_completion_distribution.ai_replied} · 隱藏完成 {health.today_completion_distribution.hidden_completed} · 導 LINE {health.today_completion_distribution.routed_line} · 待人工 {health.today_completion_distribution.to_human} · 失敗 {health.today_completion_distribution.failed} · 灰區 {health.today_completion_distribution.gray_area}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {commentSummary && (
            <div className="rounded-lg border border-stone-200 bg-stone-50/80 px-4 py-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium text-stone-600 shrink-0">戰情摘要</span>
              <button type="button" onClick={() => setInboxStatus("exceptions")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "exceptions" ? "ring-2 ring-stone-500 bg-stone-200 text-stone-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-stone-400"}`}>
                例外優先 <strong className="text-stone-800">{commentSummary.exceptions ?? 0}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("unhandled")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "unhandled" ? "ring-2 ring-stone-500 bg-stone-200 text-stone-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-stone-400"}`}>
                未處理 <strong className="text-stone-800">{commentSummary.unhandled}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("failed")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "failed" ? "ring-2 ring-red-500 bg-red-200 text-red-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-red-400"}`}>
                執行失敗 <strong className="text-red-600">{commentSummary.failed}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("sensitive")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "sensitive" ? "ring-2 ring-amber-500 bg-amber-200 text-amber-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-amber-400"}`}>
                敏感／客訴 <strong className="text-amber-700">{commentSummary.sensitive}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("to_human")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "to_human" ? "ring-2 ring-blue-500 bg-blue-200 text-blue-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-blue-400"}`}>
                待人工 <strong className="text-blue-600">{commentSummary.to_human}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("overdue")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "overdue" ? "ring-2 ring-orange-500 bg-orange-200 text-orange-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-amber-400"}`}>
                逾時 <strong className="text-amber-700">{commentSummary.overdue}</strong>
              </button>
              <button type="button" onClick={() => setInboxStatus("all")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "all" ? "ring-2 ring-stone-500 bg-stone-200 text-stone-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-stone-400"}`}>
                全部
              </button>
              <button type="button" onClick={() => setInboxStatus("completed")} className={`px-2 py-1 rounded font-medium transition-colors ${inboxStatus === "completed" ? "ring-2 ring-green-500 bg-green-200 text-green-900" : "hover:underline focus:outline-none focus:ring-1 focus:ring-green-400"}`}>
                已完成 <strong className="text-green-700">{commentSummary.completed}</strong>
              </button>
              <span className="text-stone-400 text-xs">（點數字篩選）</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="flex items-center gap-2 text-sm text-stone-600" title="例外優先時主列表不含已完成；此開關只控制是否展開下方「已完成（最近 50 筆）」區塊">
              <Switch checked={showCompletedSection} onCheckedChange={setShowCompletedSection} />
              顯示已完成
              <span className="text-xs text-stone-400 font-normal hidden sm:inline">（僅展開下方區塊）</span>
            </Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowSpotCheck(!showSpotCheck)}>
              {showSpotCheck ? "收合抽查" : "抽查已完成"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowGraySpotCheck(!showGraySpotCheck)}>
              {showGraySpotCheck ? "收合灰區抽查" : "灰區抽查"}
            </Button>
          </div>
          <div className="flex gap-4">
            <div className="w-96 shrink-0 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={inboxStatus} onValueChange={setInboxStatus}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={inboxSource} onValueChange={(v: "all" | "real" | "simulated") => setInboxSource(v)}>
                  <SelectTrigger className="w-[100px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {commentsLoading ? (
                <div className="flex items-center gap-2 text-stone-400 py-8">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">載入中...</span>
                </div>
              ) : comments.length === 0 ? (
                <p className="text-sm text-stone-400 py-8">
                  {inboxStatus === "exceptions" ? "目前沒有需要處理的例外" : "尚無留言，可於設定中串接 Meta 或先新增測試留言"}
                </p>
              ) : (
                <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 overflow-hidden bg-white">
                  {(comments as MetaCommentWithBrand[]).map((c) => {
                    const alert = cardAlert(c, commentSummary?.default_reply_minutes ?? 30);
                    const alertClass = alert === "failed" ? "border-l-4 border-l-red-500 bg-red-50/60" : alert === "high_risk" ? "border-l-4 border-l-amber-500 bg-amber-50/50" : alert === "to_human" ? "border-l-4 border-l-blue-500 bg-blue-50/50" : alert === "overdue" ? "border-l-4 border-l-orange-400 bg-orange-50/40" : "";
                    return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left px-3 py-3 hover:opacity-95 transition-opacity ${selectedId === c.id ? "bg-blue-50 border-l-4 border-l-blue-500 ring-1 ring-blue-200" : ""} ${selectedId !== c.id ? alertClass : ""}`}
                    >
                      {/* 第一行：品牌｜商品｜留言類型（待補資料時醒目） */}
                      <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-stone-800">
                        {isPendingData(c) ? (
                          <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs font-semibold">待補資料</span>
                        ) : null}
                        <span className={isPendingData(c) && !(c as MetaCommentWithBrand).brand_name?.trim() ? "text-amber-700" : "text-stone-900"}>{brandOrPending(c)}</span>
                        <span className="text-stone-400 font-normal">｜</span>
                        <span className={!(c.detected_product_name || c.post_display_name)?.trim() ? "text-amber-700" : "text-blue-700"}>{productOrPending(c)}</span>
                        <span className="text-stone-400 font-normal">｜</span>
                        <span className={["complaint", "客訴", "敏感"].includes(commentTypeLabel(c)) ? "text-amber-700" : "text-stone-600"}>{commentTypeLabel(c)}</span>
                      </div>
                      {/* 第二行：粉專名稱、貼文名稱 */}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-stone-600">
                        <span>{c.page_name || c.page_id}</span>
                        <span className="text-stone-400">·</span>
                        <span className="truncate max-w-[200px]" title={c.post_name || c.post_display_name || c.post_id}>{c.post_name || c.post_display_name || c.post_id}</span>
                      </div>
                      {/* 第三行：留言摘要 */}
                      <p className="text-sm text-stone-700 truncate mt-1.5 line-clamp-2">{c.message}</p>
                      {/* 微型處理摘要：不用點進去也知道進度 */}
                      <p className="text-xs text-stone-600 mt-1.5 font-medium">{miniProgressSummary(c)}</p>
                      {/* 第四行：狀態｜導向結果 */}
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${alert === "failed" ? "bg-red-200 text-red-800" : alert === "high_risk" ? "bg-amber-200 text-amber-900" : alert === "to_human" ? "bg-blue-200 text-blue-800" : alert === "overdue" ? "bg-orange-200 text-orange-900" : "bg-stone-200 text-stone-700"}`}>{commentStatusLabel(c)}</span>
                        <span className="text-stone-500 text-xs">｜</span>
                        <span className="text-xs text-stone-600">{routingSummary(c)}</span>
                      </div>
                      <p className="text-[10px] text-stone-400 mt-1.5">{formatDate(c.created_at)}</p>
                    </button>
                  );})}
                </div>
              )}
              {showCompletedSection && (
                <div className="mt-4 border border-stone-200 rounded-lg overflow-hidden bg-stone-50/80">
                  <p className="text-xs font-semibold text-stone-600 px-3 py-2 border-b border-stone-200">已完成（最近 50 筆）</p>
                  {completedLoading ? (
                    <div className="flex items-center gap-2 text-stone-400 py-4 px-3"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">載入中...</span></div>
                  ) : completedComments.length === 0 ? (
                    <p className="text-sm text-stone-400 py-4 px-3">尚無已完成留言</p>
                  ) : (
                    <div className="divide-y divide-stone-100 max-h-80 overflow-y-auto">
                      {completedComments.map((c) => (
                        <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`w-full text-left px-3 py-2 hover:bg-stone-100 text-sm ${selectedId === c.id ? "bg-blue-50 ring-inset ring-1 ring-blue-200" : ""}`}>
                          <span className="text-stone-700 truncate block">{c.message?.slice(0, 60)}{(c.message?.length ?? 0) > 60 ? "…" : ""}</span>
                          <span className="text-xs text-stone-500">{formatDate(c.replied_at ?? c.created_at)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showSpotCheck && (
                <div className="mt-4 border border-green-200 rounded-lg overflow-hidden bg-green-50/50">
                  <p className="text-xs font-semibold text-green-800 px-3 py-2 border-b border-green-200">抽查已完成（20 筆隨機）</p>
                  {spotCheckLoading ? (
                    <div className="flex items-center gap-2 text-stone-500 py-4 px-3"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">載入中...</span></div>
                  ) : spotCheckComments.length === 0 ? (
                    <p className="text-sm text-stone-500 py-4 px-3">尚無已完成留言可抽查</p>
                  ) : (
                    <div className="divide-y divide-green-100 max-h-80 overflow-y-auto">
                      {spotCheckComments.map((c) => (
                        <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`w-full text-left px-3 py-2 hover:bg-green-100/80 text-sm ${selectedId === c.id ? "bg-blue-50 ring-inset ring-1 ring-blue-200" : ""}`}>
                          <span className="text-stone-700 truncate block">{c.message?.slice(0, 60)}{(c.message?.length ?? 0) > 60 ? "…" : ""}</span>
                          <span className="text-xs text-stone-500">{formatDate(c.replied_at ?? c.created_at)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showGraySpotCheck && (
                <div className="mt-4 border border-amber-200 rounded-lg overflow-hidden bg-amber-50/50">
                  <p className="text-xs font-semibold text-amber-800 px-3 py-2 border-b border-amber-200">灰區抽查（20 筆隨機）</p>
                  {graySpotCheckLoading ? (
                    <div className="flex items-center gap-2 text-stone-500 py-4 px-3"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">載入中...</span></div>
                  ) : graySpotCheckComments.length === 0 ? (
                    <p className="text-sm text-stone-500 py-4 px-3">目前無灰區留言</p>
                  ) : (
                    <div className="divide-y divide-amber-100 max-h-80 overflow-y-auto">
                      {graySpotCheckComments.map((c) => (
                        <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`w-full text-left px-3 py-2 hover:bg-amber-100/80 text-sm ${selectedId === c.id ? "bg-blue-50 ring-inset ring-1 ring-blue-200" : ""}`}>
                          <span className="text-stone-700 truncate block">{c.message?.slice(0, 60)}{(c.message?.length ?? 0) > 60 ? "…" : ""}</span>
                          <span className="text-xs text-stone-500">{formatDate(c.created_at)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              {selectedComment ? (
                <Card>
                  <CardContent className="p-0">
                    {/* ————— 結論摘要面板（最上方，先於表單） ————— */}
                    <div className="rounded-t-lg border-b border-stone-200 bg-stone-50/80 p-4">
                      <p className="text-[10px] font-semibold text-stone-500 uppercase tracking-wider mb-2">結論摘要</p>
                      <p className="text-base font-semibold text-stone-800 leading-snug mb-3">
                        {brandOrPending(selectedComment)}｜{productOrPending(selectedComment)}｜{commentTypeLabel(selectedComment)}｜{routingSummary(selectedComment)}｜{selectedComment.replied_at ? "已送出" : "尚未送出"}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm text-stone-600">
                        <span><strong className="text-stone-700">品牌</strong> <span className={isPendingData(selectedComment) && !(selectedComment as MetaCommentWithBrand).brand_name?.trim() ? "text-amber-700 font-medium" : ""}>{brandOrPending(selectedComment)}</span></span>
                        <span><strong className="text-stone-700">粉專</strong> {selectedComment.page_name || selectedComment.page_id}</span>
                        <span><strong className="text-stone-700">貼文</strong> {(selectedComment.post_name || selectedComment.post_display_name || selectedComment.post_id)?.slice(0, 24)}{((selectedComment.post_name || selectedComment.post_display_name || selectedComment.post_id)?.length ?? 0) > 24 ? "…" : ""}</span>
                        <span><strong className="text-stone-700">商品</strong> <span className={!(selectedComment.detected_product_name || selectedComment.post_display_name)?.trim() ? "text-amber-700 font-medium" : ""}>{productOrPending(selectedComment)}</span></span>
                        <span><strong className="text-stone-700">判定來源</strong> {selectedComment.classifier_source === "rule" ? "規則" : selectedComment.classifier_source === "ai" ? "AI" : "—"}</span>
                        <span><strong className="text-stone-700">留言類型</strong> {commentTypeLabel(selectedComment)}</span>
                        <span><strong className="text-stone-700">優先級</strong> {selectedComment.priority === "urgent" ? "緊急／客訴" : "一般"}</span>
                        <span><strong className="text-stone-700">目前導向</strong> {channelDisplayName(selectedComment)}</span>
                        <span><strong className="text-stone-700">目前狀態</strong> {commentStatusLabel(selectedComment)}</span>
                        <span><strong className="text-stone-700">規則命中</strong> {(selectedComment as { matched_rule_bucket?: string | null }).matched_rule_bucket ? RISK_BUCKET_LABELS[(selectedComment as { matched_rule_bucket?: string }).matched_rule_bucket!] || (selectedComment as { matched_rule_bucket?: string }).matched_rule_bucket : "一般 AI"}</span>
                      </div>
                      {(selectedComment.main_status === "gray_area" || (selectedComment as { main_status?: string }).main_status === "gray_area") && (
                        <div className="mt-3 pt-3 border-t border-stone-200">
                          <Button size="sm" variant="outline" className="text-amber-700 border-amber-300 hover:bg-amber-50" onClick={async () => {
                            try {
                              const res = await fetch(`/api/meta-comments/${selectedComment.id}/mark-gray-reviewed`, { method: "POST", credentials: "include" });
                              const data = await res.json();
                              if (!res.ok) throw new Error(data.message || "請求失敗");
                              toast({ title: "已標記已檢視，狀態改為已完成" });
                              queryClient.invalidateQueries({ queryKey: ["/api/meta-comments"] });
                              queryClient.invalidateQueries({ queryKey: ["/api/meta-comments", selectedId] });
                              queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/summary"] });
                              queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/health"] });
                              queryClient.invalidateQueries({ queryKey: ["/api/meta-comments/gray-spot-check"] });
                            } catch (e) {
                              toast({ title: e instanceof Error ? e.message : "標記失敗", variant: "destructive" });
                            }
                          }}>
                            標記已檢視（改為已完成）
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* ————— 本案處理進度（系統實際執行・真相面板） ————— */}
                    <div className="border-b border-stone-200 bg-slate-50/80 px-4 py-3">
                      <p className="text-xs font-semibold text-stone-700 mb-3">本案處理進度</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-3">
                        <div>
                          <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider mb-1">建議動作</p>
                          <p className="text-stone-700">{replyFlowLabel(selectedComment)}{isHighRisk(selectedComment) ? "（建議轉客服或隱藏）" : ""}</p>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {/* 公開回覆狀態列 */}
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-white border border-stone-200 px-3 py-2">
                          <span className="text-xs font-medium text-stone-600 shrink-0 w-20">公開回覆</span>
                          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${selectedComment.reply_error ? "bg-red-200 text-red-800" : selectedComment.replied_at ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                            {selectedComment.reply_error ? "失敗" : selectedComment.replied_at ? "已送出" : "未送出"}
                          </span>
                          {(selectedComment.replied_at || selectedComment.auto_replied_at) && <span className="text-[11px] text-stone-500">{formatDate(selectedComment.replied_at || selectedComment.auto_replied_at!)}</span>}
                          {selectedComment.reply_error && <span className="text-[11px] text-red-600">失敗原因：{selectedComment.reply_error}</span>}
                        </div>
                        {/* 隱藏留言狀態列 */}
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-white border border-stone-200 px-3 py-2">
                          <span className="text-xs font-medium text-stone-600 shrink-0 w-20">隱藏留言</span>
                          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${selectedComment.hide_error ? "bg-red-200 text-red-800" : selectedComment.is_hidden === 1 ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                            {selectedComment.hide_error ? "失敗" : selectedComment.is_hidden === 1 ? "已隱藏" : "未執行"}
                          </span>
                          {selectedComment.auto_hidden_at && <span className="text-[11px] text-stone-500">{formatDate(selectedComment.auto_hidden_at)}</span>}
                          {selectedComment.hide_error && <span className="text-[11px] text-red-600">失敗原因：{selectedComment.hide_error}</span>}
                        </div>
                        {/* 導向通道狀態列 */}
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-white border border-stone-200 px-3 py-2">
                          <span className="text-xs font-medium text-stone-600 shrink-0 w-20">導向通道</span>
                          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${selectedComment.target_line_type && selectedComment.target_line_value ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                            {selectedComment.target_line_type && selectedComment.target_line_value ? `已導向 ${channelDisplayName(selectedComment)}` : "未執行／人工判讀"}
                          </span>
                          {selectedComment.replied_at && selectedComment.target_line_value && <span className="text-[11px] text-stone-500">{formatDate(selectedComment.replied_at)}</span>}
                        </div>
                        {/* 最終是否可歸檔 */}
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-white border border-stone-200 px-3 py-2">
                          <span className="text-xs font-medium text-stone-600 shrink-0 w-20">最終是否可歸檔</span>
                          {(() => {
                            const status = selectedComment.main_status ?? "";
                            const done = ["completed", "human_replied", "auto_replied", "hidden_completed"].includes(status);
                            const hasReplyErr = !!(selectedComment.reply_error?.trim());
                            const hasHideErr = !!(selectedComment.hide_error?.trim());
                            const canArchive = done && !hasReplyErr && !hasHideErr;
                            if (canArchive) return <span className="text-xs text-green-700 font-medium">可歸檔：是（5 分鐘後自動從例外消失）</span>;
                            const reasons: string[] = [];
                            if (hasReplyErr) reasons.push("回覆失敗");
                            if (hasHideErr) reasons.push("隱藏失敗");
                            if (!done && (status === "to_human" || selectedComment.is_human_handled === 1) && (selectedComment.target_line_type && selectedComment.target_line_value)) reasons.push("導 LINE 但待人工");
                            if (!done && ["unhandled", "pending_send", "routed_line", "gray_area"].includes(status)) reasons.push(status === "gray_area" ? "灰區觀察" : "待處理");
                            if (!done && (status === "failed" || status === "partial_success")) reasons.push("執行失敗或部分成功");
                            return <span className="text-xs text-amber-700 font-medium">可歸檔：否{reasons.length ? `（${reasons.join("／")}）` : ""}</span>;
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* ————— 導向通道（具體名稱＋導向原因） ————— */}
                    <div className="border-b border-stone-200 bg-amber-50/50 px-4 py-3">
                      <p className="text-xs font-semibold text-stone-700 mb-2">導向通道</p>
                      <p className="text-sm font-medium text-stone-800">{channelDisplayName(selectedComment)}</p>
                      <p className="text-xs text-amber-800 font-medium mt-1">導向原因：{routingReasonLabel(selectedComment)}</p>
                      {selectedComment.target_line_value?.trim() && (
                        <div className="mt-2">
                          <Button size="sm" variant="outline" className="text-xs" onClick={() => handleCopyOrOpenLine(selectedComment.target_line_value!)}>
                            複製／開啟導流連結
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* ————— 敏感件預設流程（僅敏感／客訴顯示） ————— */}
                    {isHighRisk(selectedComment) && (
                      <div className="border-b border-stone-200 bg-amber-50/70 px-4 py-3">
                        <p className="text-xs font-semibold text-amber-900 mb-2">敏感件預設流程</p>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="flex items-center gap-2 rounded bg-white/80 px-2 py-1.5 border border-amber-200">
                            <span className="text-stone-600 shrink-0">安撫公開回覆</span>
                            <span className={`rounded px-1.5 py-0.5 font-medium ${selectedComment.reply_error ? "bg-red-200 text-red-800" : selectedComment.replied_at ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                              {selectedComment.reply_error ? "失敗" : selectedComment.replied_at ? "已完成" : "未完成"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 rounded bg-white/80 px-2 py-1.5 border border-amber-200">
                            <span className="text-stone-600 shrink-0">隱藏留言</span>
                            <span className={`rounded px-1.5 py-0.5 font-medium ${selectedComment.hide_error ? "bg-red-200 text-red-800" : selectedComment.is_hidden === 1 ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                              {selectedComment.hide_error ? "失敗" : selectedComment.is_hidden === 1 ? "已完成" : "未完成"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 rounded bg-white/80 px-2 py-1.5 border border-amber-200">
                            <span className="text-stone-600 shrink-0">導售後 LINE</span>
                            <span className={`rounded px-1.5 py-0.5 font-medium ${selectedComment.target_line_type === "after_sale" && selectedComment.target_line_value ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                              {selectedComment.target_line_type === "after_sale" && selectedComment.target_line_value ? "已完成" : "未完成"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 rounded bg-white/80 px-2 py-1.5 border border-amber-200">
                            <span className="text-stone-600 shrink-0">待人工追蹤</span>
                            <span className={`rounded px-1.5 py-0.5 font-medium ${selectedComment.is_human_handled === 1 ? "bg-green-200 text-green-800" : "bg-stone-200 text-stone-600"}`}>
                              {selectedComment.is_human_handled === 1 ? "已完成" : "未完成"}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="p-4 space-y-4">
                    {/* ————— 先操作按鈕，再文案編輯 ————— */}
                    <div className="space-y-3 pb-3 border-b border-stone-200">
                      <p className="text-xs font-semibold text-stone-600">操作</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={handleReplyNow} disabled={replying || !(editFirst?.trim() || editSecond?.trim())}>
                          {replying ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                          立即公開回覆
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleMarkHidden} className="text-amber-700 border-amber-200">
                          <EyeOff className="w-3.5 h-3.5 mr-1" />立即隱藏留言
                        </Button>
                        {selectedComment.target_line_value?.trim() && (
                          <Button size="sm" variant="outline" onClick={() => handleCopyOrOpenLine(selectedComment.target_line_value!)}>
                            立即導 LINE
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={handleToHuman} className="text-blue-600 border-blue-200">
                          <UserCheck className="w-3.5 h-3.5 mr-1" />標記待人工
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleMarkCompleted}>
                          標記已完成
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="ghost" onClick={handleSuggestReply} disabled={suggesting}>
                          {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
                          產生建議回覆
                        </Button>
                        {templates.length > 0 && (
                          <Select onValueChange={(tid) => {
                            const t = templates.find((x) => x.id === Number(tid));
                            if (t) handleApplyTemplateAndSave(t);
                          }}>
                            <SelectTrigger className="w-[140px] h-8"><SelectValue placeholder="套用模板" /></SelectTrigger>
                            <SelectContent>
                              {templates.map((t) => (
                                <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <Button size="sm" variant="ghost" onClick={handleSaveReply}>儲存回覆內容</Button>
                      </div>
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-stone-50/50 px-3 py-2">
                      <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider mb-1">負責人</p>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        {selectedComment.assigned_agent_name ? (
                          <>
                            <span className="text-stone-700">目前負責人：{selectedComment.assigned_agent_name}</span>
                            <span className="text-stone-400">分派方式：{selectedComment.assignment_method === "manual" ? "手動" : selectedComment.assignment_method === "auto" ? "自動" : selectedComment.assignment_method === "rule" ? "規則" : selectedComment.assignment_method || "—"}</span>
                            <div className="flex gap-1">
                              <Select onValueChange={(v) => handleAssign(Number(v), assignableAgents.find((a) => a.id === Number(v))?.display_name, assignableAgents.find((a) => a.id === Number(v))?.avatar_url)}>
                                <SelectTrigger className="w-[130px] h-8"><SelectValue placeholder="改派" /></SelectTrigger>
                                <SelectContent>
                                  {assignableAgents.filter((a) => a.id !== selectedComment.assigned_agent_id).map((a) => (
                                    <SelectItem key={a.id} value={String(a.id)}>{a.display_name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button size="sm" variant="ghost" className="text-stone-500" onClick={handleUnassign}>移回待分配</Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <span className="text-stone-500">尚未指派</span>
                            <Select onValueChange={(v) => handleAssign(Number(v), assignableAgents.find((a) => a.id === Number(v))?.display_name, assignableAgents.find((a) => a.id === Number(v))?.avatar_url)}>
                              <SelectTrigger className="w-[140px] h-8"><SelectValue placeholder="指派負責人" /></SelectTrigger>
                              <SelectContent>
                                {assignableAgents.map((a) => (
                                  <SelectItem key={a.id} value={String(a.id)}>{a.display_name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1">留言原文</p>
                      <p className="text-sm text-stone-800 whitespace-pre-wrap">{selectedComment.message}</p>
                      <p className="text-[10px] text-stone-400 mt-1">{selectedComment.commenter_name} · {formatDate(selectedComment.created_at)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-stone-500">意圖</span> {selectedComment.ai_intent ? (META_COMMENT_INTENT_DISPLAY[selectedComment.ai_intent] || META_COMMENT_INTENT_LABELS[selectedComment.ai_intent] || selectedComment.ai_intent) : "—"}</div>
                      <div><span className="text-stone-500">優先級</span> {selectedComment.priority === "urgent" ? "緊急／客訴優先" : selectedComment.priority || "一般"}</div>
                      <div><span className="text-stone-500">建議隱藏</span> {selectedComment.ai_suggest_hide ? "是" : "否"}</div>
                      <div><span className="text-stone-500">建議轉客服</span> {selectedComment.ai_suggest_human ? "是" : "否"}</div>
                    </div>
                    {(selectedComment.classifier_source || selectedComment.matched_rule_keyword || selectedComment.applied_rule_id != null || selectedComment.applied_template_id != null) && (
                      <div className="rounded border border-stone-200 bg-stone-50 px-2 py-1.5 text-xs text-stone-600 space-y-0.5">
                        {selectedComment.classifier_source && (
                          <p>分類來源：{selectedComment.classifier_source === "rule" ? "規則關鍵字" : "AI"}{selectedComment.matched_rule_keyword ? `（命中關鍵字：${selectedComment.matched_rule_keyword}）` : ""}</p>
                        )}
                        {selectedComment.applied_rule_id != null && Number.isInteger(selectedComment.applied_rule_id) && (
                          <p>本次採用規則：{rules.find((r) => r.id === selectedComment.applied_rule_id)?.keyword_pattern ?? `#${selectedComment.applied_rule_id}`}</p>
                        )}
                        {selectedComment.applied_template_id != null && Number.isInteger(selectedComment.applied_template_id) && (
                          <p>本次套用模板：{templates.find((t) => t.id === selectedComment.applied_template_id)?.name ?? `#${selectedComment.applied_template_id}`}</p>
                        )}
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1">第一則（解答）</p>
                      <Textarea className="min-h-[60px] text-sm resize-y" value={editFirst} onChange={(e) => setEditFirst(e.target.value)} placeholder="先回答問題..." />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1">第二則（導商品頁／導 LINE）</p>
                      <Textarea className="min-h-[60px] text-sm resize-y" value={editSecond} onChange={(e) => setEditSecond(e.target.value)} placeholder="導購連結或導 LINE 話術..." />
                    </div>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-12 text-center text-stone-400 text-sm">
                    從左側選擇一則留言查看詳情與建議回覆
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="rules" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">關鍵字規則</CardTitle>
              <p className="text-xs text-stone-500">命中關鍵字時執行對應動作（隱藏、轉人工、使用模板等）</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 items-end">
                <div className="space-y-1">
                  <Label className="text-xs">關鍵字</Label>
                  <Input value={ruleKeyword} onChange={(e) => setRuleKeyword(e.target.value)} placeholder="例：退貨" className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">動作</Label>
                  <Select value={ruleType} onValueChange={(v: MetaCommentRule["rule_type"]) => setRuleType(v)}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RULE_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">優先順序（數字大先執行）</Label>
                  <Input type="number" value={rulePriority} onChange={(e) => setRulePriority(parseInt(e.target.value, 10) || 0)} className="h-8" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <Switch id="rule-enabled" checked={ruleEnabled} onCheckedChange={setRuleEnabled} />
                    <Label htmlFor="rule-enabled" className="text-xs">啟用</Label>
                  </div>
                  <Button size="sm" onClick={handleRuleSubmit}>{editingRuleId ? "儲存變更" : "新增規則"}</Button>
                  {editingRuleId && (
                    <Button size="sm" variant="ghost" onClick={() => setEditingRuleId(null)}><X className="w-3.5 h-3.5" /></Button>
                  )}
                </div>
              </div>
              {ruleType === "use_template" && templates.length > 0 && (
                <div className="flex gap-2 items-center">
                  <Label className="text-xs shrink-0">套用模板</Label>
                  <Select value={ruleTemplateId || "_none"} onValueChange={(v) => setRuleTemplateId(v === "_none" ? "" : v)}>
                    <SelectTrigger className="w-[200px] h-8"><SelectValue placeholder="選模板" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">— 請選擇 —</SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {ruleType === "add_tag" && (
                <div className="flex gap-2 items-center">
                  <Label className="text-xs shrink-0">標籤值</Label>
                  <Input value={ruleTagValue} onChange={(e) => setRuleTagValue(e.target.value)} placeholder="標籤" className="h-8 w-32" />
                </div>
              )}
              <ul className="space-y-2 border-t border-stone-100 pt-3">
                {rules.length === 0 ? (
                  <li className="text-sm text-stone-400">尚無規則</li>
                ) : (
                  rules.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0 gap-2">
                      <span className="text-sm truncate"><code className="bg-stone-100 px-1 rounded">{r.keyword_pattern}</code> → {RULE_TYPES.find((t) => t.value === r.rule_type)?.label || r.rule_type} {r.enabled === 0 && <span className="text-stone-400">(已停用)</span>}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <Switch checked={r.enabled !== 0} onCheckedChange={() => handleRuleToggleEnabled(r)} />
                        <Button size="sm" variant="ghost" className="text-stone-500" onClick={() => setEditingRuleId(r.id)}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-stone-400" onClick={async () => {
                          try {
                            await apiRequest("DELETE", `/api/meta-comment-rules/${r.id}`);
                            queryClient.invalidateQueries({ queryKey: ["/api/meta-comment-rules"] });
                            toast({ title: "已刪除規則" });
                          } catch {
                            toast({ title: "刪除失敗", variant: "destructive" });
                          }
                        }}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mapping" className="mt-4 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">回覆模板</CardTitle>
              <p className="text-xs text-stone-500">依情境管理第一則／第二則／客訴安撫／私訊引導</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-lg border border-stone-100 p-3 bg-stone-50/50">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">情境分類</Label>
                    <Select value={tplCategory} onValueChange={setTplCategory}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(META_COMMENT_CATEGORY_LABELS).map(([k, v]) => (
                          <SelectItem key={k} value={k}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">模板名稱</Label>
                    <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="例：一般商品詢問" className="h-8" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">第一則（解答）</Label>
                  <Textarea value={tplFirst} onChange={(e) => setTplFirst(e.target.value)} placeholder="先回答問題..." className="min-h-[52px] text-sm resize-y" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">第二則（導購，可含 {`{primary_url}`}）</Label>
                  <Textarea value={tplSecond} onChange={(e) => setTplSecond(e.target.value)} placeholder="自然導購..." className="min-h-[52px] text-sm resize-y" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">客訴安撫版</Label>
                  <Textarea value={tplComfort} onChange={(e) => setTplComfort(e.target.value)} placeholder="安撫話術..." className="min-h-[40px] text-sm resize-y" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">私訊引導</Label>
                  <Input value={tplDmGuide} onChange={(e) => setTplDmGuide(e.target.value)} placeholder="請私訊我們..." className="h-8" />
                </div>
                <div className="flex gap-2">
                  <Label className="text-xs shrink-0 pt-2">品牌語氣</Label>
                  <Input value={tplTone} onChange={(e) => setTplTone(e.target.value)} placeholder="例：親切、活潑" className="h-8 flex-1" />
                  <Button size="sm" onClick={handleTemplateSubmit}>{editingTemplateId ? "儲存變更" : "新增模板"}</Button>
                  {editingTemplateId && <Button size="sm" variant="ghost" onClick={() => setEditingTemplateId(null)}><X className="w-3.5 h-3.5" /></Button>}
                </div>
              </div>
              <ul className="space-y-2 border-t border-stone-100 pt-3">
                {templates.length === 0 ? (
                  <li className="text-sm text-stone-400">尚無模板</li>
                ) : (
                  templates.map((t) => (
                    <li key={t.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
                      <span className="text-sm"><span className="font-medium">{t.name}</span>
                      <span className="text-stone-500 ml-2">({META_COMMENT_CATEGORY_LABELS[t.category] || t.category})</span></span>
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" variant="ghost" className="text-stone-500" onClick={() => setEditingTemplateId(t.id)}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-stone-400" onClick={async () => {
                          try {
                            await apiRequest("DELETE", `/api/meta-comment-templates/${t.id}`);
                            queryClient.invalidateQueries({ queryKey: ["/api/meta-comment-templates"] });
                            toast({ title: "已刪除模板" });
                          } catch {
                            toast({ title: "刪除失敗", variant: "destructive" });
                          }
                        }}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">貼文／商品／連結對應</CardTitle>
              <p className="text-xs text-stone-500">先選粉專再選貼文，避免綁錯；同粉專＋貼文僅能有一筆啟用中的對應</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-lg border border-stone-100 p-3 bg-stone-50/50">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">粉專</Label>
                    <Select
                      value={mapPageId || "_none"}
                      onValueChange={(v) => {
                        if (v === "_none") { setMapPageId(""); setMapPageName(""); setMapPostId(""); setMapPostName(""); return; }
                        const p = metaPages.find((x) => x.page_id === v);
                        if (p) { setMapPageId(p.page_id); setMapPageName(p.page_name); setMapPostId(""); setMapPostName(""); }
                      }}
                    >
                      <SelectTrigger className="h-8"><SelectValue placeholder="選擇粉專（名稱 + ID）" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">— 不指定 / 手填 —</SelectItem>
                        {metaPages.map((p) => (
                          <SelectItem key={p.page_id} value={p.page_id}>{p.page_name} ({p.page_id})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">貼文</Label>
                    <Select
                      value={mapPostId || "_none"}
                      onValueChange={(v) => {
                        if (v === "_none") { setMapPostId(""); setMapPostName(""); return; }
                        const p = metaPostsByPage.find((x) => x.post_id === v);
                        if (p) { setMapPostId(p.post_id); setMapPostName(p.post_name); }
                      }}
                    >
                      <SelectTrigger className="h-8"><SelectValue placeholder={mapPageId ? "選擇貼文" : "先選粉專"} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">— 手填 ID —</SelectItem>
                        {metaPostsByPage.map((p) => (
                          <SelectItem key={p.post_id} value={p.post_id}>{p.post_name || p.post_id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(!mapPageId || !metaPostsByPage.find((p) => p.post_id === mapPostId)) && (
                      <div className="flex gap-1 mt-1">
                        <Input value={mapPostId} onChange={(e) => setMapPostId(e.target.value)} placeholder="貼文 ID" className="h-8 flex-1" />
                        <Input value={mapPostName} onChange={(e) => setMapPostName(e.target.value)} placeholder="貼文名稱" className="h-8 flex-1" />
                      </div>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">商品名稱</Label>
                    <Select
                      value={mapProductName && metaProducts.some((x) => x.product_name === mapProductName) ? mapProductName : "_custom"}
                      onValueChange={(v) => { if (v !== "_custom") setMapProductName(v); }}
                    >
                      <SelectTrigger className="h-8"><SelectValue placeholder="可搜尋選擇或手填下方" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_custom">{mapProductName || "手動輸入"}</SelectItem>
                        {metaProducts.map((p) => (
                          <SelectItem key={p.product_name} value={p.product_name}>{p.product_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input value={mapProductName} onChange={(e) => setMapProductName(e.target.value)} placeholder="商品名稱（可搜尋上方或直接輸入）" className="h-8 mt-0.5" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">主推連結 *</Label>
                    <Input value={mapPrimaryUrl} onChange={(e) => setMapPrimaryUrl(e.target.value)} placeholder="https://..." className="h-8" type="url" />
                    {mapPrimaryUrl && (
                      <p className="text-[10px] text-stone-400">網域：{(() => { try { return new URL(mapPrimaryUrl).hostname; } catch { return "—"; } })()}</p>
                    )}
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">備用連結</Label>
                    <Input value={mapFallbackUrl} onChange={(e) => setMapFallbackUrl(e.target.value)} placeholder="https://..." className="h-8" type="url" />
                  </div>
                </div>
                {(mapPageId || mapPostId || mapProductName || mapPrimaryUrl) && (
                  <div className="rounded border border-stone-200 bg-white p-2 text-xs">
                    <p className="font-medium text-stone-600 mb-1">預覽</p>
                    <p>粉專：{mapPageName || mapPageId || "—"}</p>
                    <p>貼文：{mapPostName || mapPostId || "—"}</p>
                    <p>商品：{mapProductName || "—"}</p>
                    <p>連結：{mapPrimaryUrl ? (() => { try { return new URL(mapPrimaryUrl).hostname; } catch { return mapPrimaryUrl.slice(0, 40); } })() : "—"}</p>
                    <p>啟用自動回覆：{mapAutoEnabled ? "是" : "否"}</p>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">此貼文偏好處理</Label>
                    <Select value={mapPreferredFlow} onValueChange={setMapPreferredFlow}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="product_link">導商品頁</SelectItem>
                        <SelectItem value="activity_link">導活動頁</SelectItem>
                        <SelectItem value="line_redirect">優先導 LINE</SelectItem>
                        <SelectItem value="support_only">僅售後／人工</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 min-w-[120px]">
                    <Label className="text-xs">話術風格</Label>
                    <Input value={mapTone} onChange={(e) => setMapTone(e.target.value)} placeholder="親切、活潑" className="h-8" />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5 pt-5">
                    <Switch id="map-auto" checked={mapAutoEnabled} onCheckedChange={setMapAutoEnabled} />
                    <Label htmlFor="map-auto" className="text-xs">啟用留言自動化</Label>
                  </div>
                  <Button size="sm" onClick={handleMappingSubmit}>{editingMappingId ? "儲存變更" : "新增對應"}</Button>
                  {editingMappingId && <Button size="sm" variant="ghost" onClick={() => setEditingMappingId(null)}><X className="w-3.5 h-3.5" /></Button>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">搜尋對應</Label>
                <Input value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} placeholder="粉專／貼文／商品名／post_id" className="h-8 max-w-[200px]" />
              </div>
              <ul className="space-y-2 border-t border-stone-100 pt-3">
                {mappings.length === 0 ? (
                  <li className="text-sm text-stone-400">尚無對應，請先選擇品牌並新增</li>
                ) : (
                  mappings.map((m) => (
                    <li key={m.id} className="text-sm py-2 border-b border-stone-100 last:border-0 flex justify-between items-center gap-2 flex-wrap">
                      <span className="truncate">{m.page_name || m.page_id} · {m.post_name || m.post_id} → {m.product_name || "—"} {m.primary_url && <a href={m.primary_url} target="_blank" rel="noreferrer" className="text-blue-600 text-xs ml-1">連結</a>} {m.auto_comment_enabled ? <span className="text-green-600 text-xs">啟用</span> : <span className="text-stone-400 text-xs">停用</span>}</span>
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" variant="outline" className="text-xs" onClick={() => handleTestMapping(m.id)}>測試此 mapping</Button>
                        <Button size="sm" variant="ghost" className="text-stone-500" onClick={() => setEditingMappingId(m.id)}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-stone-400" onClick={async () => {
                          try {
                            await apiRequest("DELETE", `/api/meta-post-mappings/${m.id}`);
                            queryClient.invalidateQueries({ queryKey: ["/api/meta-post-mappings"] });
                            toast({ title: "已刪除對應" });
                          } catch {
                            toast({ title: "刪除失敗", variant: "destructive" });
                          }
                        }}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="page-settings" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">粉專與 LINE 導向設定</CardTitle>
              <p className="text-xs text-stone-500">一眼看出哪個粉專導哪個 LINE；一般 LINE、售後 LINE、敏感件預設與自動開關</p>
            </CardHeader>
            <CardContent>
              {pageSettingsList.length === 0 ? (
                <p className="text-sm text-stone-500 py-6">尚無粉專設定，請於系統設定或 Meta 串接中新增粉專後在此設定導向</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-stone-200 text-left text-stone-600 font-medium">
                        <th className="py-2 pr-3">品牌</th>
                        <th className="py-2 pr-3">粉專</th>
                        <th className="py-2 pr-3">一般 LINE</th>
                        <th className="py-2 pr-3">售後 LINE</th>
                        <th className="py-2 pr-3">敏感件預設</th>
                        <th className="py-2 pr-3">自動回覆</th>
                        <th className="py-2 pr-3">自動隱藏</th>
                        <th className="py-2 pr-3">預設商品</th>
                        <th className="py-2 pr-3">預設處理方式</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageSettingsList.map((row) => (
                        <tr key={row.id} className="border-b border-stone-100 hover:bg-stone-50/50">
                          <td className="py-2.5 pr-3 font-medium text-stone-800">{row.brand_name ?? "—"}</td>
                          <td className="py-2.5 pr-3 text-stone-700">{row.page_name || row.page_id}</td>
                          <td className="py-2.5 pr-3">{row.line_general ? <span className="text-green-700 truncate block max-w-[140px]" title={row.line_general}>已設定</span> : <span className="text-stone-400">—</span>}</td>
                          <td className="py-2.5 pr-3">{row.line_after_sale ? <span className="text-green-700 truncate block max-w-[140px]" title={row.line_after_sale}>已設定</span> : <span className="text-stone-400">—</span>}</td>
                          <td className="py-2.5 pr-3">{row.auto_hide_sensitive ? "自動隱藏" : "不自動隱藏"}</td>
                          <td className="py-2.5 pr-3">{row.auto_reply_enabled ? "開" : "關"}</td>
                          <td className="py-2.5 pr-3">{row.auto_route_line_enabled ? "開" : "關"}</td>
                          <td className="py-2.5 pr-3 text-stone-600">{row.default_product_name || "—"}</td>
                          <td className="py-2.5 pr-3 text-stone-600">{row.default_flow === "product_link" ? "導商品頁" : row.default_flow === "line_redirect" ? "導 LINE" : row.default_flow === "activity_link" ? "導活動頁" : row.default_flow || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="risk-rules" className="mt-4 space-y-6">
          <p className="text-sm text-stone-500">五桶規則：白名單 → 隱藏+導LINE → 直接隱藏 → 只導LINE → 灰區。判定順序依此執行，可自訂關鍵字與動作。</p>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TestTube className="w-4 h-4" />
                留言規則測試器
              </CardTitle>
              <p className="text-xs text-stone-500">輸入一句留言，即時預覽會命中哪個規則桶與執行動作</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Label className="text-xs text-stone-500">品牌</Label>
                  <p className="text-sm font-medium text-stone-700">{selectedBrandId != null ? `品牌 ID ${selectedBrandId}` : "全部品牌"}</p>
                </div>
                <div>
                  <Label className="text-xs text-stone-500">粉專 ID（選填）</Label>
                  <Input value={ruleTestPageId} onChange={(e) => setRuleTestPageId(e.target.value)} placeholder="page_demo" className="h-8" />
                </div>
              </div>
              <div className="flex gap-2">
                <Input value={ruleTestMessage} onChange={(e) => setRuleTestMessage(e.target.value)} placeholder="例如：你們客服是不是都不回，我訂單到底在哪" className="flex-1" />
                <Button size="sm" onClick={async () => {
                  setRuleTestLoading(true);
                  setRuleTestResult(null);
                  try {
                    const res = await fetch("/api/meta-comments/test-rules", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({
                        message: ruleTestMessage,
                        brand_id: selectedBrandId ?? undefined,
                        page_id: ruleTestPageId.trim() || undefined,
                      }),
                    });
                    const data = await res.json();
                    setRuleTestResult({
                      matches: data.matches ?? [],
                      final: data.final ? { matched_rule_bucket: data.final.matched_rule_bucket, matched_keyword: data.final.matched_keyword, action_reply: data.final.action_reply, action_hide: data.final.action_hide, action_route_line: data.final.action_route_line, action_mark_to_human: data.final.action_mark_to_human, route_line_type: data.final.route_line_type ?? null } : null,
                      reason: data.reason ?? "",
                      decisionSummary: data.decisionSummary ?? "",
                      target_line_display: data.target_line_display ?? "",
                      brand_id: data.brand_id ?? selectedBrandId ?? null,
                      page_id: ruleTestPageId.trim() || undefined,
                    });
                  } catch {
                    setRuleTestResult(null);
                  } finally {
                    setRuleTestLoading(false);
                  }
                }} disabled={ruleTestLoading || !ruleTestMessage.trim()}>
                  {ruleTestLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "測試"}
                </Button>
              </div>
              {ruleTestResult && (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm space-y-3">
                  {(ruleTestResult.brand_id != null || ruleTestResult.page_id) && (
                    <p className="text-xs text-stone-500">本次測試使用品牌：{ruleTestResult.brand_id != null ? `ID ${ruleTestResult.brand_id}` : "全部"}｜粉專：{ruleTestResult.page_id || "全部"}</p>
                  )}
                  {ruleTestResult.decisionSummary && (
                    <div className="rounded bg-white border border-stone-100 p-2">
                      <p className="font-semibold text-stone-800 text-xs mb-1">決策摘要（營運用）</p>
                      <p className="text-stone-700 text-xs whitespace-pre-wrap">{ruleTestResult.decisionSummary.split("｜").join("\n")}</p>
                    </div>
                  )}
                  <p className="font-semibold text-stone-800">採用原因</p>
                  <p className="text-stone-700">{ruleTestResult.reason}</p>
                  {(ruleTestResult.matches?.length ?? 0) > 0 && (
                    <>
                      <p className="font-semibold text-stone-800 mt-2">候選命中規則（{ruleTestResult.matches.length} 條）</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-stone-200">
                              <th className="text-left py-1 font-medium text-stone-600">桶別</th>
                              <th className="text-left py-1 font-medium text-stone-600">關鍵字</th>
                              <th className="text-left py-1 font-medium text-stone-600">優先級</th>
                              <th className="text-left py-1 font-medium text-stone-600">規則名稱</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(ruleTestResult.matches ?? []).map((m, i) => (
                              <tr key={i} className="border-b border-stone-100">
                                <td className="py-1">{RISK_BUCKET_LABELS[m.rule_bucket] || m.rule_bucket}</td>
                                <td className="py-1">{m.keyword_pattern}</td>
                                <td className="py-1">{m.priority}</td>
                                <td className="py-1">{m.rule_name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  {ruleTestResult.final && (
                    <>
                      <p className="font-semibold text-stone-800 mt-2">預期流程</p>
                      <ul className="text-stone-600 text-xs space-y-0.5">
                        <li>• 公開回覆：{ruleTestResult.final.action_reply ? "是" : "否"}</li>
                        <li>• 隱藏：{ruleTestResult.final.action_hide ? "是" : "否"}</li>
                        <li>• 導 LINE：{ruleTestResult.final.action_route_line ? "是" : "否"}{ruleTestResult.final.action_route_line && ruleTestResult.target_line_display ? `（${ruleTestResult.target_line_display}）` : ""}</li>
                        <li>• 待人工：{ruleTestResult.final.action_mark_to_human ? "是" : "否"}</li>
                        <li>• 預計主狀態：{ruleTestResult.final.action_hide && !ruleTestResult.final.action_reply ? "hidden_completed" : ruleTestResult.final.action_mark_to_human ? "to_human" : ruleTestResult.final.action_route_line ? "routed_line" : "completed"}</li>
                      </ul>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {editingRiskRuleId != null && (
            <Card>
              <CardHeader className="py-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">{editingRiskRuleId === -1 ? "新增規則（由複製）" : "編輯規則"}</CardTitle>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditingRiskRuleId(null); setRiskRuleForm(null); }}>取消</Button>
                  <Button size="sm" onClick={async () => {
                    const f = riskRuleForm ?? editingRiskRule;
                    if (!f?.rule_name || !f?.keyword_pattern || !f?.rule_bucket) { toast({ title: "請填寫規則名稱、關鍵字與桶別", variant: "destructive" }); return; }
                    if (editingRiskRuleId > 0) {
                      await apiRequest("PUT", `/api/meta-comment-risk-rules/${editingRiskRuleId}`, { rule_name: f.rule_name, keyword_pattern: f.keyword_pattern, match_type: f.match_type ?? "contains", rule_bucket: f.rule_bucket, priority: f.priority ?? 0, enabled: f.enabled !== 0 ? 1 : 0, brand_id: f.brand_id ?? null, page_id: f.page_id ?? null, action_reply: f.action_reply ? 1 : 0, action_hide: f.action_hide ? 1 : 0, action_route_line: f.action_route_line ? 1 : 0, route_line_type: f.route_line_type ?? null, action_mark_to_human: f.action_mark_to_human ? 1 : 0, action_use_template_id: f.action_use_template_id ?? null, notes: f.notes ?? null });
                      toast({ title: "已儲存規則" });
                    } else {
                      await apiRequest("POST", "/api/meta-comment-risk-rules", { rule_name: f.rule_name, keyword_pattern: f.keyword_pattern, match_type: f.match_type ?? "contains", rule_bucket: f.rule_bucket, priority: f.priority ?? 0, enabled: f.enabled !== 0 ? 1 : 0, brand_id: f.brand_id ?? null, page_id: f.page_id ?? null, action_reply: f.action_reply ? 1 : 0, action_hide: f.action_hide ? 1 : 0, action_route_line: f.action_route_line ? 1 : 0, route_line_type: f.route_line_type ?? null, action_mark_to_human: f.action_mark_to_human ? 1 : 0, action_use_template_id: f.action_use_template_id ?? null, notes: f.notes ?? null });
                      toast({ title: "已新增規則" });
                    }
                    setEditingRiskRuleId(null); setRiskRuleForm(null); refetchRiskRules();
                  }}>儲存</Button>
                </div>
              </CardHeader>
              <CardContent className="py-2">
                {editingRiskRuleId > 0 && !riskRuleForm ? (
                  <div className="flex items-center gap-2 text-stone-500 py-4"><Loader2 className="w-4 h-4 animate-spin" />載入中...</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                    <div><Label className="text-xs">規則名稱</Label><Input value={riskRuleForm?.rule_name ?? ""} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, rule_name: e.target.value } : null)} className="h-8" /></div>
                    <div><Label className="text-xs">關鍵字／pattern</Label><Input value={riskRuleForm?.keyword_pattern ?? ""} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, keyword_pattern: e.target.value } : null)} className="h-8" /></div>
                    <div><Label className="text-xs">比對方式</Label><Select value={riskRuleForm?.match_type ?? "contains"} onValueChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, match_type: v as "contains" | "exact" | "regex" } : null)}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="contains">包含</SelectItem><SelectItem value="exact">完全</SelectItem><SelectItem value="regex">正則</SelectItem></SelectContent></Select></div>
                    <div><Label className="text-xs">規則桶</Label><Select value={riskRuleForm?.rule_bucket || "whitelist"} onValueChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, rule_bucket: v as MetaCommentRiskRule["rule_bucket"] } : null)}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent>{(["whitelist", "direct_hide", "hide_and_route", "route_only", "gray_area"] as const).map((b) => <SelectItem key={b} value={b}>{RISK_BUCKET_LABELS[b]}</SelectItem>)}</SelectContent></Select></div>
                    <div><Label className="text-xs">優先級</Label><Input type="number" value={riskRuleForm?.priority ?? 0} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, priority: parseInt(e.target.value, 10) || 0 } : null)} className="h-8" /></div>
                    <div className="flex items-center gap-2"><Label className="text-xs">啟用</Label><Switch checked={(riskRuleForm?.enabled ?? 1) !== 0} onCheckedChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, enabled: v ? 1 : 0 } : null)} /></div>
                    <div><Label className="text-xs">品牌 ID（選填）</Label><Input type="number" value={riskRuleForm?.brand_id ?? ""} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, brand_id: e.target.value ? parseInt(e.target.value, 10) : null } : null)} placeholder="空=全品牌" className="h-8" /></div>
                    <div><Label className="text-xs">粉專 ID（選填）</Label><Input value={riskRuleForm?.page_id ?? ""} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, page_id: e.target.value || null } : null)} placeholder="空=全粉專" className="h-8" /></div>
                    <div className="flex items-center gap-2"><Label className="text-xs">回覆</Label><Switch checked={(riskRuleForm?.action_reply ?? 0) !== 0} onCheckedChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, action_reply: v ? 1 : 0 } : null)} /></div>
                    <div className="flex items-center gap-2"><Label className="text-xs">隱藏</Label><Switch checked={(riskRuleForm?.action_hide ?? 0) !== 0} onCheckedChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, action_hide: v ? 1 : 0 } : null)} /></div>
                    <div className="flex items-center gap-2"><Label className="text-xs">導 LINE</Label><Switch checked={(riskRuleForm?.action_route_line ?? 0) !== 0} onCheckedChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, action_route_line: v ? 1 : 0 } : null)} /></div>
                    <div><Label className="text-xs">LINE 類型</Label><Select value={riskRuleForm?.route_line_type ?? "none"} onValueChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, route_line_type: v === "none" ? null : (v as "general" | "after_sale") } : null)}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">—</SelectItem><SelectItem value="general">一般</SelectItem><SelectItem value="after_sale">售後</SelectItem></SelectContent></Select></div>
                    <div className="flex items-center gap-2"><Label className="text-xs">待人工</Label><Switch checked={(riskRuleForm?.action_mark_to_human ?? 0) !== 0} onCheckedChange={(v) => setRiskRuleForm(prev => prev ? { ...prev, action_mark_to_human: v ? 1 : 0 } : null)} /></div>
                    <div><Label className="text-xs">備註</Label><Input value={riskRuleForm?.notes ?? ""} onChange={(e) => setRiskRuleForm(prev => prev ? { ...prev, notes: e.target.value || null } : null)} className="h-8" /></div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Input placeholder="搜規則名稱或關鍵字" value={riskRuleSearchQ} onChange={(e) => setRiskRuleSearchQ(e.target.value)} className="h-8 w-48" />
            <Select value={riskRuleFilterBucket} onValueChange={setRiskRuleFilterBucket}>
              <SelectTrigger className="h-8 w-36"><SelectValue placeholder="桶別" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部桶別</SelectItem>
                {(["whitelist", "direct_hide", "hide_and_route", "route_only", "gray_area"] as const).map((b) => <SelectItem key={b} value={b}>{RISK_BUCKET_LABELS[b]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={riskRuleFilterEnabled} onValueChange={setRiskRuleFilterEnabled}>
              <SelectTrigger className="h-8 w-28"><SelectValue placeholder="啟用" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="1">啟用</SelectItem>
                <SelectItem value="0">停用</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(["whitelist", "direct_hide", "hide_and_route", "route_only", "gray_area"] as const).map((bucket) => {
            const rules = riskRulesList.filter((r) => r.rule_bucket === bucket);
            return (
              <Card key={bucket}>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">{RISK_BUCKET_LABELS[bucket]}</CardTitle>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-stone-200">
                          <th className="text-left py-1.5 font-medium text-stone-600">規則名稱</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">關鍵字</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">比對</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">優先級</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">品牌/粉專</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">動作摘要</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">啟用</th>
                          <th className="text-left py-1.5 font-medium text-stone-600">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((r) => (
                          <tr key={r.id} className="border-b border-stone-100">
                            <td className="py-1.5 font-medium text-stone-800">{r.rule_name || "—"}</td>
                            <td className="py-1.5">{r.keyword_pattern}</td>
                            <td className="py-1.5">{r.match_type === "regex" ? "正則" : r.match_type === "exact" ? "完全" : "包含"}</td>
                            <td className="py-1.5 flex items-center gap-0.5">
                              <button type="button" className="p-0.5 rounded hover:bg-stone-200 text-stone-500 text-xs" title="優先級+1" onClick={async () => { await apiRequest("PUT", `/api/meta-comment-risk-rules/${r.id}`, { priority: (r.priority ?? 0) + 1 }); refetchRiskRules(); }}>▲</button>
                              <span className="min-w-[1.25rem] text-center">{r.priority ?? 0}</span>
                              <button type="button" className="p-0.5 rounded hover:bg-stone-200 text-stone-500 text-xs" title="優先級-1" onClick={async () => { await apiRequest("PUT", `/api/meta-comment-risk-rules/${r.id}`, { priority: Math.max(0, (r.priority ?? 0) - 1) }); refetchRiskRules(); }}>▼</button>
                            </td>
                            <td className="py-1.5 text-xs text-stone-500">{r.brand_id != null ? `品牌${r.brand_id}` : "—"} {r.page_id ? `/${r.page_id}` : ""}</td>
                            <td className="py-1.5 text-xs text-stone-600">{ruleActionSummary(r)}</td>
                            <td className="py-1.5">{r.enabled ? "是" : "否"}</td>
                            <td className="py-1.5 flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 text-stone-600" onClick={() => { setEditingRiskRuleId(r.id); }}><Pencil className="w-3.5 h-3.5" /></Button>
                              <Button size="sm" variant="ghost" className="h-7 text-blue-600" onClick={() => { setRiskRuleForm({ ...r, rule_name: r.rule_name + " (複製)" }); setEditingRiskRuleId(-1); }} title="複製為新規則">複製</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-red-600" onClick={async () => {
                                if (!confirm("確定刪除此規則？")) return;
                                await fetch(`/api/meta-comment-risk-rules/${r.id}`, { method: "DELETE", credentials: "include" });
                                refetchRiskRules();
                                if (editingRiskRuleId === r.id) { setEditingRiskRuleId(null); setRiskRuleForm(null); }
                              }}><Trash2 className="w-3.5 h-3.5" /></Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <form className="flex gap-2 mt-2" onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const kw = (form.querySelector('input[name="newKeyword"]') as HTMLInputElement)?.value?.trim();
                    if (!kw) return;
                    await apiRequest("POST", "/api/meta-comment-risk-rules", {
                      rule_name: `手動: ${kw}`,
                      rule_bucket: bucket,
                      keyword_pattern: kw,
                      match_type: "contains",
                      priority: 0,
                      action_reply: bucket === "whitelist" ? 1 : bucket === "hide_and_route" || bucket === "route_only" ? 1 : 0,
                      action_hide: bucket === "direct_hide" || bucket === "hide_and_route" ? 1 : 0,
                      action_route_line: bucket === "hide_and_route" || bucket === "route_only" ? 1 : 0,
                      action_mark_to_human: bucket === "hide_and_route" ? 1 : 0,
                      route_line_type: bucket === "hide_and_route" ? "after_sale" : bucket === "route_only" ? "general" : null,
                    });
                    (form.querySelector('input[name="newKeyword"]') as HTMLInputElement).value = "";
                    refetchRiskRules();
                    toast({ title: "已新增規則" });
                  }}>
                    <Input name="newKeyword" placeholder="新增關鍵字（包含）" className="h-8 max-w-[200px]" />
                    <Button type="submit" size="sm">新增</Button>
                  </form>
                  <div className="mt-2 flex flex-col gap-1">
                    <Textarea name={`batchKeywords-${bucket}`} placeholder="批次新增關鍵字（一行一個）" className="min-h-[60px] text-sm resize-y max-w-md" />
                    <Button size="sm" variant="outline" onClick={async () => {
                      const ta = document.querySelector(`textarea[name="batchKeywords-${bucket}"]`) as HTMLTextAreaElement;
                      const raw = (ta?.value ?? "").split(/\n/).map((s) => s.trim()).filter(Boolean);
                      if (raw.length === 0) { toast({ title: "請輸入至少一筆關鍵字", variant: "destructive" }); return; }
                      const uniqueLines = [...new Set(raw)];
                      const existingKeywords = new Set(rules.map((r) => r.keyword_pattern));
                      const toAdd = uniqueLines.filter((kw) => !existingKeywords.has(kw));
                      const defaults = { rule_bucket: bucket, match_type: "contains" as const, priority: 0, brand_id: null as number | null, page_id: null as string | null, action_reply: bucket === "whitelist" ? 1 : bucket === "hide_and_route" || bucket === "route_only" ? 1 : 0, action_hide: bucket === "direct_hide" || bucket === "hide_and_route" ? 1 : 0, action_route_line: bucket === "hide_and_route" || bucket === "route_only" ? 1 : 0, action_mark_to_human: bucket === "hide_and_route" ? 1 : 0, route_line_type: bucket === "hide_and_route" ? "after_sale" : bucket === "route_only" ? "general" : null };
                      let added = 0;
                      for (const kw of toAdd) {
                        await apiRequest("POST", "/api/meta-comment-risk-rules", { rule_name: `手動: ${kw}`, keyword_pattern: kw, ...defaults });
                        added++;
                        existingKeywords.add(kw);
                      }
                      ta.value = "";
                      refetchRiskRules();
                      const skipped = raw.length - added;
                      if (skipped > 0) toast({ title: `批次新增完成：成功 ${added} 條，略過 ${skipped} 條（同批重複或資料庫已有）` });
                      else toast({ title: `已批次新增 ${added} 條規則` });
                    }}>批次新增</Button>
                  </div>
                  <p className="text-xs text-stone-500 mt-1">共 {rules.length} 筆</p>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="simulate" className="mt-4 space-y-6">
          <p className="text-sm text-stone-500">尚未串接真實 Meta/Facebook 前，可在此建立模擬留言並在收件匣驗證 AI 判讀、規則、模板、mapping 與 fallback。</p>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">測試留言建立器</CardTitle>
              <p className="text-xs text-stone-500">手動新增一筆模擬留言，建立後會出現在留言收件匣</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">粉專 ID</Label>
                  <Input value={simPageId} onChange={(e) => setSimPageId(e.target.value)} placeholder="page_demo" className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">粉專名稱</Label>
                  <Input value={simPageName} onChange={(e) => setSimPageName(e.target.value)} placeholder="示範粉專" className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">貼文 ID</Label>
                  <Input value={simPostId} onChange={(e) => setSimPostId(e.target.value)} placeholder="post_001" className="h-8" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">貼文名稱</Label>
                  <Input value={simPostName} onChange={(e) => setSimPostName(e.target.value)} placeholder="測試貼文" className="h-8" />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">留言者名稱</Label>
                  <Input value={simCommenterName} onChange={(e) => setSimCommenterName(e.target.value)} placeholder="模擬用戶" className="h-8" />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">留言內容 *</Label>
                  <Textarea value={simMessage} onChange={(e) => setSimMessage(e.target.value)} placeholder="例：請問這款還有貨嗎？" className="min-h-[60px] text-sm resize-y" />
                </div>
              </div>
              <Button onClick={handleCreateSimulatedComment} disabled={!simMessage.trim()}>
                <Send className="w-3.5 h-3.5 mr-1" />
                建立模擬留言
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模擬 Webhook</CardTitle>
              <p className="text-xs text-stone-500">貼上類 Meta payload 或留空用上方欄位組一筆，僅供本機/內測驗證後端流程</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">JSON（可留空，則用上方粉專/貼文/留言者/內容）</Label>
                <Textarea value={simWebhookJson} onChange={(e) => setSimWebhookJson(e.target.value)} placeholder='{"message":"請問多少錢？","commenter_name":"測試","post_id":"post_001","page_id":"page_demo"}' className="min-h-[80px] font-mono text-xs resize-y" />
              </div>
              <Button variant="outline" onClick={handleSimulateWebhook}>
                送出模擬 Webhook
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">一鍵測試案例</CardTitle>
              <p className="text-xs text-stone-500">預設 6 種情境各一筆：一般詢問、價格、哪裡買、活動、客訴、退款。建立後到收件匣點選並按「產生建議回覆」驗證</p>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "一般商品詢問", msg: "請問這款現在還有貨嗎？" },
                  { label: "價格詢問", msg: "多少錢？" },
                  { label: "哪裡買", msg: "哪裡可以買？" },
                  { label: "活動互動", msg: "+1 想抽" },
                  { label: "客訴", msg: "我上週訂的還沒收到，你們是不是都不回訊息" },
                  { label: "退款", msg: "我要退款" },
                ].map(({ label }) => (
                  <span key={label} className="text-xs text-stone-500 rounded bg-stone-100 px-2 py-1">{label}</span>
                ))}
              </div>
              <Button className="mt-3" onClick={handleSeedTestCases} disabled={seedLoading}>
                {seedLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                一鍵建立 6 筆測試留言
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="batch-pages" className="mt-4 space-y-4">
          <p className="text-sm text-stone-500">貼上 Meta User Access Token（具 pages_show_list 權限）取得可管理粉專，多選後指定品牌一鍵建立 Messenger 渠道與留言中心設定。新匯入預設：AI 關、自動留言關、只收訊。</p>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">取得粉專列表</CardTitle>
              <p className="text-xs text-stone-500">從 Meta 開發者後台或 Graph API Explorer 取得 User Access Token</p>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label className="text-xs">User Access Token</Label>
              <Input
                type="password"
                value={metaBatchToken}
                onChange={(e) => setMetaBatchToken(e.target.value)}
                placeholder="EAAx..."
                className="font-mono text-sm"
              />
              <Button onClick={fetchMetaBatchPages} disabled={metaBatchLoading}>
                {metaBatchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                取得粉專列表
              </Button>
            </CardContent>
          </Card>
          {metaBatchPages.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">選擇粉專並指定品牌</CardTitle>
                <p className="text-xs text-stone-500">勾選要匯入的粉專，選擇歸屬品牌後按「一鍵建立」</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2 max-h-[200px] overflow-y-auto border border-stone-200 rounded p-2">
                  {metaBatchPages.map((p) => (
                    <label key={p.page_id} className="flex items-center gap-1.5 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={metaBatchSelected.has(p.page_id)}
                        onChange={(e) => {
                          setMetaBatchSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.page_id);
                            else next.delete(p.page_id);
                            return next;
                          });
                        }}
                      />
                      <span className="truncate max-w-[180px]" title={p.page_name}>{p.page_name}</span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Label className="text-xs shrink-0">歸屬品牌</Label>
                  <Select value={metaBatchBrandId} onValueChange={setMetaBatchBrandId}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="選擇品牌" />
                    </SelectTrigger>
                    <SelectContent>
                      {brandsList.map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={doMetaBatchImport} disabled={metaBatchImporting || metaBatchSelected.size === 0}>
                    {metaBatchImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                    一鍵建立（{metaBatchSelected.size} 個粉專）
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
