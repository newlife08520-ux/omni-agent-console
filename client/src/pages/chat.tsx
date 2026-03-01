import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Send, User, Bot, Headphones, UserCheck, Search, X, Plus, Tag,
  Circle, Zap, Star, Info, Package, Crown, ShoppingBag, Loader2,
  Paperclip, ImageIcon, Upload,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ContactWithPreview, Message, OrderInfo, ORDER_STATUS_LABELS } from "@shared/schema";

const ORDER_STATUS_MAP: Record<string, { label: string; color: string }> = {
  new_order: { label: "新訂單", color: "bg-blue-50 text-blue-600 border-blue-200" },
  shipped: { label: "已出貨", color: "bg-emerald-50 text-emerald-600 border-emerald-200" },
  pending: { label: "待處理", color: "bg-amber-50 text-amber-600 border-amber-200" },
  completed: { label: "已完成", color: "bg-stone-50 text-stone-600 border-stone-200" },
  cancelled: { label: "已取消", color: "bg-red-50 text-red-600 border-red-200" },
  delay_handling: { label: "延遲處理", color: "bg-orange-50 text-orange-600 border-orange-200" },
  returned: { label: "已退貨", color: "bg-rose-50 text-rose-600 border-rose-200" },
};

const STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  pending: { label: "待處理", color: "bg-red-50 text-red-600 border-red-200", dot: "bg-red-500" },
  processing: { label: "處理中", color: "bg-amber-50 text-amber-600 border-amber-200", dot: "bg-amber-500" },
  resolved: { label: "已解決", color: "bg-emerald-50 text-emerald-600 border-emerald-200", dot: "bg-emerald-500" },
};

const TAG_COLORS: Record<string, string> = {
  "VIP": "bg-violet-50 text-violet-600 border-violet-200",
  "客訴": "bg-red-50 text-red-600 border-red-200",
  "重要": "bg-orange-50 text-orange-600 border-orange-200",
  "回購客戶": "bg-emerald-50 text-emerald-600 border-emerald-200",
  "新客戶": "bg-sky-50 text-sky-600 border-sky-200",
};

function getTagColor(tag: string) {
  return TAG_COLORS[tag] || "bg-stone-50 text-stone-600 border-stone-200";
}

const QUICK_REPLIES = [
  "感謝您的詢問，我們將盡快為您處理！",
  "請提供您的訂單編號，我將為您查詢。",
  "好的，馬上為您處理，請稍候片刻。",
];

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
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [rightTab, setRightTab] = useState("info");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchResults, setOrderSearchResults] = useState<OrderInfo[]>([]);
  const [orderSearching, setOrderSearching] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; preview: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sendingRating, setSendingRating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const quickReplyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lastMessageIdRef = useRef<number>(0);

  const { data: contacts = [], isLoading: contactsLoading } = useQuery<ContactWithPreview[]>({
    queryKey: ["/api/contacts"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 3000,
  });

  const { data: messages = [], isLoading: messagesLoading } = useQuery<Message[]>({
    queryKey: ["/api/contacts", selectedId, "messages"],
    queryFn: async () => {
      if (!selectedId) return [];
      const res = await fetch(`/api/contacts/${selectedId}/messages`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!selectedId,
    refetchInterval: 3000,
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
    if (messages.length > 0) {
      const latestId = messages[messages.length - 1].id;
      if (latestId > lastMessageIdRef.current) {
        const isFirstLoad = lastMessageIdRef.current === 0;
        lastMessageIdRef.current = latestId;
        scrollToBottom(isFirstLoad ? "auto" : "smooth");
      }
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    lastMessageIdRef.current = 0;
    scrollToBottom("auto");
  }, [selectedId, scrollToBottom]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (quickReplyRef.current && !quickReplyRef.current.contains(e.target as Node)) setShowQuickReplies(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId);
  const filteredContacts = contacts.filter((c) => c.display_name.toLowerCase().includes(searchQuery.toLowerCase()));

  const handleSendMessage = useCallback(async () => {
    if (!messageInput.trim() || !selectedId || sending) return;
    setSending(true);
    try {
      await apiRequest("POST", `/api/contacts/${selectedId}/messages`, { content: messageInput.trim() });
      setMessageInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch { toast({ title: "傳送失敗", variant: "destructive" }); }
    finally { setSending(false); }
  }, [messageInput, selectedId, sending, queryClient, toast]);

  const handleToggleHuman = async (contactId: number, currentFlag: number) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/human`, { needs_human: currentFlag ? 0 : 1 });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleStatusChange = async (status: string) => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
    } catch { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleTogglePin = async (contactId: number, currentPinned: number) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/pinned`, { is_pinned: currentPinned ? 0 : 1 });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch { toast({ title: "操作失敗", variant: "destructive" }); }
  };

  const handleAddTag = async () => {
    if (!newTag.trim() || !selectedContact) return;
    const currentTags: string[] = JSON.parse(selectedContact.tags || "[]");
    if (currentTags.includes(newTag.trim())) { setNewTag(""); return; }
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: [...currentTags, newTag.trim()] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setNewTag("");
    } catch { toast({ title: "新增標籤失敗", variant: "destructive" }); }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!selectedContact) return;
    const currentTags: string[] = JSON.parse(selectedContact.tags || "[]");
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: currentTags.filter((t) => t !== tagToRemove) });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch { toast({ title: "移除標籤失敗", variant: "destructive" }); }
  };

  const handleOrderSearch = async () => {
    if (!orderSearch.trim()) return;
    setOrderSearching(true);
    try {
      const params = orderSearch.match(/^\d{4,}$/)
        ? `phone=${encodeURIComponent(orderSearch.trim())}`
        : `order_id=${encodeURIComponent(orderSearch.trim())}`;
      const res = await fetch(`/api/orders/lookup?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setOrderSearchResults(data.orders || []);
      if (data.error) {
        toast({ title: data.message || "查詢失敗", variant: "destructive" });
      } else if (data.orders?.length === 0) {
        toast({ title: "未找到相關訂單" });
      }
    } catch { toast({ title: "查詢失敗", variant: "destructive" }); }
    finally { setOrderSearching(false); }
  };

  const handleQuickReply = (text: string) => { setMessageInput(text); setShowQuickReplies(false); };

  const handleSendRating = useCallback(async () => {
    if (!selectedId || sendingRating) return;
    if (selectedContact?.cs_rating != null) {
      toast({ title: "客戶已評分過", description: "此客戶已完成滿意度評分，無法重複發送", variant: "destructive" });
      return;
    }
    setSendingRating(true);
    try {
      const res = await fetch(`/api/contacts/${selectedId}/send-rating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "已發送評價卡片", description: "滿意度調查已傳送給客戶" });
        queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
        queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      } else {
        toast({ title: "發送失敗", description: data.message, variant: "destructive" });
      }
    } catch { toast({ title: "發送失敗", variant: "destructive" }); }
    finally { setSendingRating(false); }
  }, [selectedId, sendingRating, selectedContact, queryClient, toast]);

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
    if (validFiles.length > 0) setPendingFiles((prev) => [...prev, ...validFiles]);
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
    if (pendingFiles.length === 0 || !selectedId || uploading) return;
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
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch { toast({ title: "傳送失敗", variant: "destructive" }); }
    finally { setUploading(false); }
  }, [pendingFiles, selectedId, uploading, queryClient, toast]);

  const handleSendAll = useCallback(async () => {
    if (sending || uploading) return;
    if (pendingFiles.length > 0) await uploadAndSendFiles();
    if (messageInput.trim()) await handleSendMessage();
  }, [pendingFiles, messageInput, sending, uploading, uploadAndSendFiles, handleSendMessage]);

  const formatTime = (dateStr: string) => new Date(dateStr.replace(" ", "T")).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  const formatDate = (dateStr: string) => new Date(dateStr.replace(" ", "T")).toLocaleDateString("zh-TW", { month: "short", day: "numeric" });
  const getInitials = (name: string) => name.charAt(0);
  const avatarColors = ["bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-sky-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];
  const contactTags = selectedContact ? JSON.parse(selectedContact.tags || "[]") as string[] : [];

  return (
    <div className="flex h-full bg-[#faf9f5]" data-testid="chat-page">
      <div className="w-[300px] min-w-[300px] border-r border-stone-200 flex flex-col bg-white">
        <div className="p-3 border-b border-stone-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <Input data-testid="input-search-contacts" placeholder="搜尋聯絡人..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 bg-stone-50 border-stone-200" />
          </div>
        </div>
        <ScrollArea className="flex-1">
          {contactsLoading ? (
            <div className="p-6 text-center text-sm text-stone-400">載入中...</div>
          ) : filteredContacts.length === 0 ? (
            <div className="p-6 text-center text-sm text-stone-400">無聯絡人</div>
          ) : (
            <div className="p-2 space-y-0.5">
              {filteredContacts.map((contact) => {
                const tags: string[] = JSON.parse(contact.tags || "[]");
                const statusInfo = STATUS_MAP[contact.status] || STATUS_MAP.pending;
                return (
                  <button key={contact.id} onClick={() => { setSelectedId(contact.id); lastMessageIdRef.current = 0; }}
                    className={`w-full flex items-start gap-3 p-3 rounded-2xl text-left transition-all ${selectedId === contact.id ? "bg-emerald-50/70 ring-1 ring-emerald-200" : "hover:bg-stone-50"}`}
                    data-testid={`contact-item-${contact.id}`}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="w-11 h-11">
                        <AvatarFallback className={`${getAvatarColor(contact.id)} text-white text-sm font-semibold`}>{getInitials(contact.display_name)}</AvatarFallback>
                      </Avatar>
                      {contact.needs_human ? (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full border-2 border-white flex items-center justify-center">
                          <Headphones className="w-2.5 h-2.5 text-white" />
                        </div>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1 min-w-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleTogglePin(contact.id, contact.is_pinned); }}
                            className="shrink-0"
                            data-testid={`button-pin-${contact.id}`}
                          >
                            <Star className={`w-3.5 h-3.5 transition-colors ${contact.is_pinned ? "fill-amber-400 text-amber-400" : "text-stone-300 hover:text-amber-400"}`} />
                          </button>
                          <span className="text-sm font-semibold text-stone-800 truncate">{contact.display_name}</span>
                          {contact.vip_level > 0 && <VipBadge level={contact.vip_level} />}
                        </div>
                        {contact.last_message_at && <span className="text-[11px] text-stone-400 shrink-0">{formatTime(contact.last_message_at)}</span>}
                      </div>
                      {contact.last_message && <p className="text-xs text-stone-500 truncate mt-0.5">{contact.last_message}</p>}
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusInfo.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dot}`} />{statusInfo.label}
                        </span>
                        {tags.slice(0, 2).map((tag) => (
                          <span key={tag} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${getTagColor(tag)}`}>{tag}</span>
                        ))}
                        {tags.length > 2 && <span className="text-[10px] text-stone-400">+{tags.length - 2}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
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
                  <AvatarFallback className={`${getAvatarColor(selectedContact?.id || 0)} text-white text-sm`}>{selectedContact ? getInitials(selectedContact.display_name) : "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-bold text-stone-800 truncate" data-testid="text-selected-contact">{selectedContact?.display_name}</h3>
                    {selectedContact?.is_pinned ? <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 shrink-0" /> : null}
                    {selectedContact && selectedContact.vip_level > 0 && <VipBadge level={selectedContact.vip_level} />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Circle className="w-2 h-2 fill-emerald-500 text-emerald-500" />
                    <span className="text-[11px] text-stone-400">LINE</span>
                    {selectedContact && selectedContact.order_count > 0 && (
                      <span className="text-[11px] text-stone-400 ml-1">| {selectedContact.order_count} 筆訂單 · ${selectedContact.total_spent.toLocaleString()}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Select value={selectedContact?.status || "pending"} onValueChange={handleStatusChange}>
                  <SelectTrigger className="w-[130px] h-8 text-xs border-stone-200" data-testid="select-contact-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" />待處理</span></SelectItem>
                    <SelectItem value="processing"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" />處理中</span></SelectItem>
                    <SelectItem value="resolved"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />已解決</span></SelectItem>
                  </SelectContent>
                </Select>
                {selectedContact?.needs_human ? (
                  <Badge variant="destructive" className="gap-1 text-xs"><Headphones className="w-3 h-3" />人工模式</Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs bg-stone-100 text-stone-600"><Bot className="w-3 h-3" />AI 模式</Badge>
                )}
                <Button size="sm" variant={selectedContact?.needs_human ? "secondary" : "default"}
                  onClick={() => selectedContact && handleToggleHuman(selectedContact.id, selectedContact.needs_human)}
                  data-testid="button-toggle-human"
                  className={`text-xs ${!selectedContact?.needs_human ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}`}
                >
                  {selectedContact?.needs_human ? <><Bot className="w-3.5 h-3.5 mr-1" />恢復 AI</> : <><UserCheck className="w-3.5 h-3.5 mr-1" />轉人工</>}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2 px-5 py-2 border-b border-stone-100 bg-[#faf9f5]/50 flex-wrap">
              <Tag className="w-3.5 h-3.5 text-stone-400 shrink-0" />
              {contactTags.map((tag) => (
                <span key={tag} className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${getTagColor(tag)}`}>
                  {tag}<button onClick={() => handleRemoveTag(tag)} className="hover:opacity-70" data-testid={`button-remove-tag-${tag}`}><X className="w-3 h-3" /></button>
                </span>
              ))}
              <div className="flex items-center gap-1">
                <Input data-testid="input-add-tag" placeholder="新增標籤..." value={newTag} onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                  className="h-6 w-24 text-xs bg-transparent border-stone-200 px-2" />
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleAddTag} data-testid="button-add-tag"><Plus className="w-3 h-3" /></Button>
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
                  {messagesLoading ? (
                    <div className="text-center text-sm text-stone-400 py-8">載入訊息中...</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-sm text-stone-400 py-8">尚無對話紀錄</div>
                  ) : (
                    <div className="space-y-4 max-w-2xl mx-auto">
                      {messages.map((msg, index) => {
                        const showDate = index === 0 || formatDate(msg.created_at) !== formatDate(messages[index - 1].created_at);

                        if (msg.sender_type === "system") {
                          return (
                            <div key={msg.id}>
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
                          <div key={msg.id}>
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
                                      <img src={msg.image_url} alt="附件圖片" className="max-w-full max-h-[280px] object-contain cursor-pointer rounded-2xl" onClick={() => window.open(msg.image_url!, "_blank")} data-testid={`image-message-${msg.id}`} />
                                    </div>
                                  ) : msg.message_type === "video" && msg.image_url ? (
                                    <div className={`rounded-2xl overflow-hidden shadow-sm ${
                                      msg.sender_type === "user" ? "rounded-bl-md border border-stone-100"
                                        : msg.sender_type === "ai" ? "rounded-br-md border border-emerald-100"
                                        : "rounded-br-md"
                                    }`}>
                                      <video controls className="max-w-full max-h-[280px] rounded-2xl" data-testid={`video-message-${msg.id}`}>
                                        <source src={msg.image_url} type="video/mp4" />
                                        您的瀏覽器不支援影片播放
                                      </video>
                                    </div>
                                  ) : (
                                    <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                                      msg.sender_type === "user" ? "bg-white text-stone-700 rounded-bl-md border border-stone-100"
                                        : msg.sender_type === "ai" ? "bg-emerald-50 text-emerald-900 rounded-br-md border border-emerald-100"
                                        : "bg-amber-600 text-white rounded-br-md"
                                    }`}>{msg.content}</div>
                                  )}
                                  <div className={`text-[10px] text-stone-400 mt-1 ${msg.sender_type === "user" ? "text-left" : "text-right"}`}>
                                    {msg.sender_type === "ai" ? "AI 助理 " : msg.sender_type === "admin" ? "真人客服 " : ""}{formatTime(msg.created_at)}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
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
                    <div className="p-4 space-y-4">
                      <div className="text-center pb-3 border-b border-stone-100">
                        <Avatar className="w-16 h-16 mx-auto mb-2">
                          <AvatarFallback className={`${getAvatarColor(selectedContact?.id || 0)} text-white text-xl font-bold`}>{selectedContact ? getInitials(selectedContact.display_name) : "?"}</AvatarFallback>
                        </Avatar>
                        <p className="font-semibold text-stone-800">{selectedContact?.display_name}</p>
                        {selectedContact && selectedContact.vip_level > 0 && <div className="mt-1"><VipBadge level={selectedContact.vip_level} /></div>}
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-stone-500">平台</span>
                          <span className="text-stone-800">LINE</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-stone-500">平台 ID</span>
                          <span className="text-stone-800 font-mono text-[11px] truncate max-w-[140px]">{selectedContact?.platform_user_id}</span>
                        </div>
                        {selectedContact && selectedContact.order_count > 0 && (
                          <>
                            <div className="flex justify-between text-xs">
                              <span className="text-stone-500">訂單數</span>
                              <span className="text-stone-800">{selectedContact.order_count} 筆</span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-stone-500">累計消費</span>
                              <span className="text-stone-800 font-semibold">${selectedContact.total_spent.toLocaleString()}</span>
                            </div>
                          </>
                        )}
                        <div className="flex justify-between text-xs">
                          <span className="text-stone-500">建立日期</span>
                          <span className="text-stone-800">{selectedContact?.created_at ? formatDate(selectedContact.created_at) : "-"}</span>
                        </div>
                        {selectedContact?.cs_rating != null && (
                          <div className="flex justify-between text-xs" data-testid="text-cs-rating">
                            <span className="text-stone-500">滿意度評分</span>
                            <span className="text-amber-500 font-semibold">{"⭐".repeat(selectedContact.cs_rating)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="orders" className="flex-1 overflow-auto m-0">
                    <div className="p-3 space-y-3">
                      <div className="flex gap-1.5">
                        <Input data-testid="input-order-search" placeholder="訂單號或手機號碼..." value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleOrderSearch(); }}
                          className="text-xs bg-stone-50 border-stone-200 h-8" />
                        <Button size="sm" onClick={handleOrderSearch} disabled={orderSearching || !orderSearch.trim()} data-testid="button-search-order" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white shrink-0">
                          {orderSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                        </Button>
                      </div>

                      {orderSearchResults.length > 0 ? (
                        <div className="space-y-2">
                          {orderSearchResults.map((order, i) => {
                            const statusInfo = ORDER_STATUS_MAP[order.status] || { label: order.status, color: "bg-stone-50 text-stone-600 border-stone-200" };
                            return (
                              <div key={i} className="rounded-xl border border-stone-200 p-3 space-y-2" data-testid={`order-card-${i}`}>
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-mono font-semibold text-stone-800" data-testid={`order-id-${i}`}>{order.global_order_id}</span>
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusInfo.color}`}>{statusInfo.label}</span>
                                </div>
                                <div className="text-xs text-stone-600">
                                  <div className="flex justify-between">
                                    <span>金額</span>
                                    <span className="font-semibold">${order.final_total_order_amount.toLocaleString()}</span>
                                  </div>
                                  {order.tracking_number && (
                                    <div className="flex justify-between mt-0.5">
                                      <span>物流單號</span>
                                      <span className="font-mono text-[11px]">{order.tracking_number}</span>
                                    </div>
                                  )}
                                  {order.product_list && (
                                    <div className="mt-1.5 pt-1.5 border-t border-stone-100">
                                      <span className="text-stone-500 text-[11px]">品項：</span>
                                      <p className="text-[11px] text-stone-700 mt-0.5 line-clamp-3">{order.product_list}</p>
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
                          <p className="text-xs text-stone-400">輸入訂單號或手機號碼查詢</p>
                          <p className="text-[11px] text-stone-400 mt-0.5">透過一頁商店 API 即時查詢</p>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>

            <div className="border-t border-stone-200 bg-white">
              {pendingFiles.length > 0 && (
                <div className="px-4 pt-3 pb-1" data-testid="file-preview-area">
                  <div className="flex gap-2 flex-wrap max-w-2xl mx-auto">
                    {pendingFiles.map((pf, i) => (
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
                  <Button size="icon" variant="ghost" className="h-10 w-10 text-stone-400 hover:text-emerald-600 hover:bg-emerald-50" onClick={() => fileInputRef.current?.click()} data-testid="button-attach-file">
                    <Paperclip className="w-5 h-5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-10 w-10 text-amber-400 hover:text-amber-500 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={handleSendRating}
                    disabled={sendingRating || !selectedContact || selectedContact.platform !== "line" || selectedContact.cs_rating != null}
                    title={selectedContact?.cs_rating != null ? "客戶已評分過" : "發送滿意度評價卡片"}
                    data-testid="button-send-rating"
                  >
                    {sendingRating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className="w-5 h-5 fill-current" />}
                  </Button>
                  <Input data-testid="input-message" placeholder="輸入訊息以真人客服身分回覆..." value={messageInput} onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendAll(); } }} disabled={sending || uploading} className="bg-stone-50 border-stone-200" />
                  <Button onClick={handleSendAll} disabled={(!messageInput.trim() && pendingFiles.length === 0) || sending || uploading} data-testid="button-send-message" className="bg-emerald-600 hover:bg-emerald-700 text-white px-4">
                    {uploading ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />上傳中</> : <><Send className="w-4 h-4 mr-1.5" />傳送</>}
                  </Button>
                </div>
                <p className="text-[10px] text-stone-400 text-center mt-2">以管理員身分發送訊息 · 支援圖片拖曳上傳或點擊 📎 附件按鈕</p>
              </div>
            </div>
          </>
        )}
      </div>
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
