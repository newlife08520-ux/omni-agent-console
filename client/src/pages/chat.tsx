import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Send,
  User,
  Bot,
  Headphones,
  UserCheck,
  Search,
  X,
  Plus,
  Tag,
  Circle,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Contact, ContactWithPreview, Message } from "@shared/schema";

const STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  pending: { label: "待處理", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400", dot: "bg-red-500" },
  processing: { label: "處理中", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", dot: "bg-amber-500" },
  resolved: { label: "已解決", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400", dot: "bg-emerald-500" },
};

const TAG_COLORS: Record<string, string> = {
  "VIP": "bg-violet-100 text-violet-700",
  "客訴": "bg-red-100 text-red-700",
  "重要": "bg-orange-100 text-orange-700",
  "回購客戶": "bg-emerald-100 text-emerald-700",
  "新客戶": "bg-blue-100 text-blue-700",
};

function getTagColor(tag: string) {
  return TAG_COLORS[tag] || "bg-gray-100 text-gray-700";
}

export default function ChatPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [newTag, setNewTag] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (messages.length > 0) {
      const latestId = messages[messages.length - 1].id;
      if (latestId > lastMessageIdRef.current) {
        lastMessageIdRef.current = latestId;
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [messages]);

  const selectedContact = contacts.find((c) => c.id === selectedId);
  const filteredContacts = contacts.filter((c) =>
    c.display_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSendMessage = useCallback(async () => {
    if (!messageInput.trim() || !selectedId || sending) return;
    setSending(true);
    try {
      await apiRequest("POST", `/api/contacts/${selectedId}/messages`, { content: messageInput.trim() });
      setMessageInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch {
      toast({ title: "傳送失敗", variant: "destructive" });
    } finally {
      setSending(false);
    }
  }, [messageInput, selectedId, sending, queryClient, toast]);

  const handleToggleHuman = async (contactId: number, currentFlag: number) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/human`, { needs_human: currentFlag ? 0 : 1 });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleStatusChange = async (status: string) => {
    if (!selectedId) return;
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/status`, { status });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
    }
  };

  const handleAddTag = async () => {
    if (!newTag.trim() || !selectedContact) return;
    const currentTags: string[] = JSON.parse(selectedContact.tags || "[]");
    if (currentTags.includes(newTag.trim())) {
      setNewTag("");
      return;
    }
    const updatedTags = [...currentTags, newTag.trim()];
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: updatedTags });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setNewTag("");
    } catch {
      toast({ title: "新增標籤失敗", variant: "destructive" });
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!selectedContact) return;
    const currentTags: string[] = JSON.parse(selectedContact.tags || "[]");
    const updatedTags = currentTags.filter((t) => t !== tagToRemove);
    try {
      await apiRequest("PUT", `/api/contacts/${selectedId}/tags`, { tags: updatedTags });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch {
      toast({ title: "移除標籤失敗", variant: "destructive" });
    }
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr.replace(" ", "T"));
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr.replace(" ", "T"));
    return d.toLocaleDateString("zh-TW", { month: "short", day: "numeric" });
  };

  const getInitials = (name: string) => name.charAt(0);

  const avatarColors = ["bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500", "bg-rose-500", "bg-cyan-500", "bg-indigo-500"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];

  const contactTags = selectedContact ? JSON.parse(selectedContact.tags || "[]") as string[] : [];

  return (
    <div className="flex h-full bg-gray-50 dark:bg-slate-950" data-testid="chat-page">
      {/* Contact List */}
      <div className="w-[320px] min-w-[320px] border-r border-gray-200 dark:border-slate-800 flex flex-col bg-white dark:bg-slate-900">
        <div className="p-3 border-b border-gray-200 dark:border-slate-800">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              data-testid="input-search-contacts"
              placeholder="搜尋聯絡人..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-gray-50 dark:bg-slate-800 border-gray-200 dark:border-slate-700"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          {contactsLoading ? (
            <div className="p-6 text-center text-sm text-gray-400">載入中...</div>
          ) : filteredContacts.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">無聯絡人</div>
          ) : (
            <div className="p-2 space-y-0.5">
              {filteredContacts.map((contact) => {
                const tags: string[] = JSON.parse(contact.tags || "[]");
                const statusInfo = STATUS_MAP[contact.status] || STATUS_MAP.pending;
                return (
                  <button
                    key={contact.id}
                    onClick={() => { setSelectedId(contact.id); lastMessageIdRef.current = 0; }}
                    className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition-all ${
                      selectedId === contact.id
                        ? "bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-200 dark:ring-blue-800"
                        : "hover:bg-gray-50 dark:hover:bg-slate-800"
                    }`}
                    data-testid={`contact-item-${contact.id}`}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="w-11 h-11">
                        <AvatarFallback className={`${getAvatarColor(contact.id)} text-white text-sm font-semibold`}>
                          {getInitials(contact.display_name)}
                        </AvatarFallback>
                      </Avatar>
                      {contact.needs_human ? (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full border-2 border-white dark:border-slate-900 flex items-center justify-center">
                          <Headphones className="w-2.5 h-2.5 text-white" />
                        </div>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">{contact.display_name}</span>
                        {contact.last_message_at && (
                          <span className="text-[11px] text-gray-400 shrink-0">{formatTime(contact.last_message_at)}</span>
                        )}
                      </div>
                      {contact.last_message && (
                        <p className="text-xs text-gray-500 dark:text-slate-400 truncate mt-0.5">{contact.last_message}</p>
                      )}
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${statusInfo.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dot}`} />
                          {statusInfo.label}
                        </span>
                        {tags.slice(0, 2).map((tag) => (
                          <span key={tag} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${getTagColor(tag)}`}>{tag}</span>
                        ))}
                        {tags.length > 2 && (
                          <span className="text-[10px] text-gray-400">+{tags.length - 2}</span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center">
                <MessageSquareEmpty className="w-10 h-10 text-gray-300 dark:text-slate-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-600 dark:text-slate-400">選擇一位聯絡人</h3>
              <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">從左側列表選擇聯絡人開始對話</p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header with CRM */}
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="w-9 h-9 shrink-0">
                  <AvatarFallback className={`${getAvatarColor(selectedContact?.id || 0)} text-white text-sm`}>
                    {selectedContact ? getInitials(selectedContact.display_name) : "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate" data-testid="text-selected-contact">
                    {selectedContact?.display_name}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <Circle className="w-2 h-2 fill-emerald-500 text-emerald-500" />
                    <span className="text-[11px] text-gray-400">LINE</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Select value={selectedContact?.status || "pending"} onValueChange={handleStatusChange}>
                  <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-contact-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" />待處理</span>
                    </SelectItem>
                    <SelectItem value="processing">
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" />處理中</span>
                    </SelectItem>
                    <SelectItem value="resolved">
                      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />已解決</span>
                    </SelectItem>
                  </SelectContent>
                </Select>

                {selectedContact?.needs_human ? (
                  <Badge variant="destructive" className="gap-1 text-xs">
                    <Headphones className="w-3 h-3" />
                    人工模式
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <Bot className="w-3 h-3" />
                    AI 模式
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant={selectedContact?.needs_human ? "secondary" : "default"}
                  onClick={() => selectedContact && handleToggleHuman(selectedContact.id, selectedContact.needs_human)}
                  data-testid="button-toggle-human"
                  className="text-xs"
                >
                  {selectedContact?.needs_human ? (
                    <><Bot className="w-3.5 h-3.5 mr-1" />恢復 AI</>
                  ) : (
                    <><UserCheck className="w-3.5 h-3.5 mr-1" />轉人工</>
                  )}
                </Button>
              </div>
            </div>

            {/* Tags bar */}
            <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/50 flex-wrap">
              <Tag className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              {contactTags.map((tag) => (
                <span key={tag} className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${getTagColor(tag)}`}>
                  {tag}
                  <button onClick={() => handleRemoveTag(tag)} className="hover:opacity-70" data-testid={`button-remove-tag-${tag}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  data-testid="input-add-tag"
                  placeholder="新增標籤..."
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                  className="h-6 w-24 text-xs bg-transparent border-gray-200 dark:border-slate-700 px-2"
                />
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleAddTag} data-testid="button-add-tag">
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 bg-gray-50 dark:bg-slate-950">
              <div className="p-5">
                {messagesLoading ? (
                  <div className="text-center text-sm text-gray-400 py-8">載入訊息中...</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-sm text-gray-400 py-8">尚無對話紀錄</div>
                ) : (
                  <div className="space-y-4 max-w-2xl mx-auto">
                    {messages.map((msg, index) => {
                      const showDate = index === 0 || formatDate(msg.created_at) !== formatDate(messages[index - 1].created_at);
                      return (
                        <div key={msg.id}>
                          {showDate && (
                            <div className="flex justify-center my-5">
                              <span className="text-[11px] text-gray-400 bg-white dark:bg-slate-800 px-3 py-1 rounded-full shadow-sm border border-gray-100 dark:border-slate-700">
                                {formatDate(msg.created_at)}
                              </span>
                            </div>
                          )}
                          <div className={`flex ${msg.sender_type === "user" ? "justify-start" : "justify-end"}`} data-testid={`message-${msg.id}`}>
                            <div className={`flex items-end gap-2 max-w-[70%] ${msg.sender_type === "user" ? "flex-row" : "flex-row-reverse"}`}>
                              <div className="shrink-0 mb-1">
                                {msg.sender_type === "user" ? (
                                  <Avatar className="w-7 h-7">
                                    <AvatarFallback className="bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-300 text-xs">
                                      <User className="w-3.5 h-3.5" />
                                    </AvatarFallback>
                                  </Avatar>
                                ) : msg.sender_type === "ai" ? (
                                  <Avatar className="w-7 h-7">
                                    <AvatarFallback className="bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 text-xs">
                                      <Bot className="w-3.5 h-3.5" />
                                    </AvatarFallback>
                                  </Avatar>
                                ) : (
                                  <Avatar className="w-7 h-7">
                                    <AvatarFallback className="bg-blue-600 text-white text-xs">
                                      <Headphones className="w-3.5 h-3.5" />
                                    </AvatarFallback>
                                  </Avatar>
                                )}
                              </div>
                              <div>
                                <div
                                  className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                                    msg.sender_type === "user"
                                      ? "bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 rounded-bl-md border border-gray-100 dark:border-slate-700"
                                      : msg.sender_type === "ai"
                                      ? "bg-sky-50 dark:bg-sky-950/40 text-sky-900 dark:text-sky-100 rounded-br-md border border-sky-100 dark:border-sky-900/50"
                                      : "bg-blue-600 text-white rounded-br-md"
                                  }`}
                                >
                                  {msg.content}
                                </div>
                                <div className={`text-[10px] text-gray-400 mt-1 ${msg.sender_type === "user" ? "text-left" : "text-right"}`}>
                                  {msg.sender_type === "ai" ? "AI 助理 " : msg.sender_type === "admin" ? "真人客服 " : ""}
                                  {formatTime(msg.created_at)}
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
            </ScrollArea>

            {/* Message Input */}
            <div className="p-4 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              <div className="flex gap-2 max-w-2xl mx-auto">
                <Input
                  data-testid="input-message"
                  placeholder="輸入訊息以真人客服身分回覆..."
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
                  }}
                  disabled={sending}
                  className="bg-gray-50 dark:bg-slate-800 border-gray-200 dark:border-slate-700"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!messageInput.trim() || sending}
                  data-testid="button-send-message"
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4"
                >
                  <Send className="w-4 h-4 mr-1.5" />
                  傳送
                </Button>
              </div>
              <p className="text-[10px] text-gray-400 text-center mt-2">以管理員身分發送訊息，將以真人客服樣式顯示</p>
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
