import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Send,
  User,
  Bot,
  Headphones,
  UserCheck,
  Search,
  Circle,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Contact, Message } from "@shared/schema";
import { getQueryFn } from "@/lib/queryClient";

export default function ChatPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lastMessageIdRef = useRef<number>(0);

  const { data: contacts = [], isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 3000,
  });

  const { data: messages = [], isLoading: messagesLoading } = useQuery<Message[]>({
    queryKey: ["/api/contacts", selectedId, "messages"],
    queryFn: async () => {
      if (!selectedId) return [];
      const res = await fetch(`/api/contacts/${selectedId}/messages`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch messages");
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
      await apiRequest("POST", `/api/contacts/${selectedId}/messages`, {
        content: messageInput.trim(),
      });
      setMessageInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", selectedId, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch {
      toast({ title: "傳送失敗", description: "無法傳送訊息", variant: "destructive" });
    } finally {
      setSending(false);
    }
  }, [messageInput, selectedId, sending, queryClient, toast]);

  const handleToggleHuman = async (contactId: number, currentFlag: number) => {
    try {
      await apiRequest("PUT", `/api/contacts/${contactId}/human`, {
        needs_human: currentFlag ? 0 : 1,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({
        title: currentFlag ? "已恢復 AI 接管" : "已切換人工模式",
        description: currentFlag ? "AI 將繼續為客戶服務" : "管理員可手動回覆客戶",
      });
    } catch {
      toast({ title: "操作失敗", variant: "destructive" });
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

  const getInitials = (name: string) => {
    return name.charAt(0);
  };

  const getAvatarColor = (id: number) => {
    const colors = [
      "bg-blue-500",
      "bg-emerald-500",
      "bg-violet-500",
      "bg-amber-500",
      "bg-rose-500",
      "bg-cyan-500",
    ];
    return colors[id % colors.length];
  };

  return (
    <div className="flex h-full" data-testid="chat-page">
      <div className="w-80 border-r flex flex-col bg-background">
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              data-testid="input-search-contacts"
              placeholder="搜尋聯絡人..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          {contactsLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">載入中...</div>
          ) : filteredContacts.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">無聯絡人</div>
          ) : (
            <div className="p-1">
              {filteredContacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => {
                    setSelectedId(contact.id);
                    lastMessageIdRef.current = 0;
                  }}
                  className={`w-full flex items-start gap-3 p-3 rounded-md text-left transition-colors ${
                    selectedId === contact.id
                      ? "bg-accent"
                      : "hover-elevate"
                  }`}
                  data-testid={`contact-item-${contact.id}`}
                >
                  <Avatar className="w-10 h-10 shrink-0">
                    <AvatarFallback className={`${getAvatarColor(contact.id)} text-white text-sm font-medium`}>
                      {getInitials(contact.display_name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium truncate">{contact.display_name}</span>
                      {contact.last_message_at && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatTime(contact.last_message_at)}
                        </span>
                      )}
                    </div>
                    {(contact as any).last_message && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {(contact as any).last_message}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                        LINE
                      </Badge>
                      {contact.needs_human ? (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 shrink-0">
                          需人工
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquareEmpty className="w-16 h-16 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-muted-foreground">選擇一個聯絡人</h3>
              <p className="text-sm text-muted-foreground/70 mt-1">從左側列表選擇聯絡人開始對話</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-background">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="w-9 h-9 shrink-0">
                  <AvatarFallback className={`${getAvatarColor(selectedContact?.id || 0)} text-white text-sm`}>
                    {selectedContact ? getInitials(selectedContact.display_name) : "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate" data-testid="text-selected-contact">
                    {selectedContact?.display_name}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <Circle className="w-2 h-2 fill-emerald-500 text-emerald-500" />
                    <span className="text-xs text-muted-foreground">LINE</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedContact?.needs_human ? (
                  <Badge variant="destructive" className="gap-1">
                    <Headphones className="w-3 h-3" />
                    人工模式
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <Bot className="w-3 h-3" />
                    AI 模式
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant={selectedContact?.needs_human ? "secondary" : "default"}
                  onClick={() =>
                    selectedContact && handleToggleHuman(selectedContact.id, selectedContact.needs_human)
                  }
                  data-testid="button-toggle-human"
                >
                  {selectedContact?.needs_human ? (
                    <>
                      <Bot className="w-3.5 h-3.5 mr-1" />
                      恢復 AI
                    </>
                  ) : (
                    <>
                      <UserCheck className="w-3.5 h-3.5 mr-1" />
                      轉人工
                    </>
                  )}
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1 p-4">
              {messagesLoading ? (
                <div className="text-center text-sm text-muted-foreground py-8">載入訊息中...</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-8">尚無對話紀錄</div>
              ) : (
                <div className="space-y-3 max-w-3xl mx-auto">
                  {messages.map((msg, index) => {
                    const showDate =
                      index === 0 ||
                      formatDate(msg.created_at) !== formatDate(messages[index - 1].created_at);
                    return (
                      <div key={msg.id}>
                        {showDate && (
                          <div className="flex justify-center my-4">
                            <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                              {formatDate(msg.created_at)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex ${msg.sender_type === "user" ? "justify-start" : "justify-end"}`}
                          data-testid={`message-${msg.id}`}
                        >
                          <div
                            className={`flex items-end gap-2 max-w-[75%] ${
                              msg.sender_type === "user" ? "flex-row" : "flex-row-reverse"
                            }`}
                          >
                            <div className="shrink-0 mb-1">
                              {msg.sender_type === "user" ? (
                                <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center">
                                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                                </div>
                              ) : msg.sender_type === "ai" ? (
                                <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                                  <Bot className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                                </div>
                              ) : (
                                <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center">
                                  <Headphones className="w-3.5 h-3.5 text-primary-foreground" />
                                </div>
                              )}
                            </div>
                            <div>
                              <div
                                className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                                  msg.sender_type === "user"
                                    ? "bg-muted text-foreground rounded-bl-md"
                                    : msg.sender_type === "ai"
                                    ? "bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-100 rounded-br-md"
                                    : "bg-primary text-primary-foreground rounded-br-md"
                                }`}
                              >
                                {msg.content}
                              </div>
                              <div
                                className={`text-[10px] text-muted-foreground mt-1 ${
                                  msg.sender_type === "user" ? "text-left" : "text-right"
                                }`}
                              >
                                {msg.sender_type === "ai" ? "AI " : msg.sender_type === "admin" ? "管理員 " : ""}
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
            </ScrollArea>

            <div className="p-3 border-t bg-background">
              <div className="flex gap-2 max-w-3xl mx-auto">
                <Input
                  data-testid="input-message"
                  placeholder="輸入訊息..."
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  disabled={sending}
                />
                <Button
                  size="icon"
                  onClick={handleSendMessage}
                  disabled={!messageInput.trim() || sending}
                  data-testid="button-send-message"
                >
                  <Send className="w-4 h-4" />
                </Button>
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
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h.01" />
      <path d="M12 10h.01" />
      <path d="M16 10h.01" />
    </svg>
  );
}
