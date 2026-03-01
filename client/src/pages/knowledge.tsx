import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Brain,
  Upload,
  Trash2,
  FileText,
  Save,
  FlaskConical,
  Send,
  Bot,
  User,
  AlertTriangle,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Setting, KnowledgeFile } from "@shared/schema";

interface SandboxMessage {
  role: "user" | "ai";
  content: string;
}

export default function KnowledgePage() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sandboxMessages, setSandboxMessages] = useState<SandboxMessage[]>([]);
  const [sandboxInput, setSandboxInput] = useState("");
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sandboxEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  if (!promptLoaded && settings.length > 0) {
    const prompt = settings.find((s) => s.key === "system_prompt");
    if (prompt) { setSystemPrompt(prompt.value); setPromptLoaded(true); }
  }

  const { data: files = [], isLoading: filesLoading } = useQuery<KnowledgeFile[]>({
    queryKey: ["/api/knowledge-files"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const handleSavePrompt = async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/settings", { key: "system_prompt", value: systemPrompt });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "儲存成功", description: "系統指令已更新" });
    } catch {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleUploadFile = useCallback(async (file: File) => {
    const allowed = [".txt", ".pdf", ".csv", ".docx"];
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!allowed.includes(ext)) {
      toast({ title: "檔案格式錯誤", description: "僅支援 .txt, .pdf, .csv, .docx", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/knowledge-files", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "上傳成功", description: `${file.name} 已上傳` });
    } catch { toast({ title: "上傳失敗", variant: "destructive" }); }
    finally { setUploading(false); }
  }, [queryClient, toast]);

  const handleDeleteFile = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/knowledge-files/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "刪除成功" });
    } catch { toast({ title: "刪除失敗", variant: "destructive" }); }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleUploadFile(droppedFile);
  }, [handleUploadFile]);

  const handleSandboxSend = async () => {
    if (!sandboxInput.trim() || sandboxLoading) return;
    const userMsg = sandboxInput.trim();
    setSandboxMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setSandboxInput("");
    setSandboxLoading(true);
    try {
      const res = await fetch("/api/sandbox/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "no_api_key" || data.error === "invalid_api_key") {
          toast({ title: "API Key 錯誤", description: data.message, variant: "destructive" });
          setSandboxMessages((prev) => [...prev, { role: "ai", content: `⚠️ ${data.message}` }]);
        } else {
          toast({ title: "回覆失敗", description: data.message, variant: "destructive" });
          setSandboxMessages((prev) => [...prev, { role: "ai", content: `⚠️ ${data.message}` }]);
        }
      } else {
        setSandboxMessages((prev) => [...prev, { role: "ai", content: data.reply }]);
      }
    } catch {
      setSandboxMessages((prev) => [...prev, { role: "ai", content: "⚠️ 連線失敗，請稍後再試。" }]);
    } finally {
      setSandboxLoading(false);
      setTimeout(() => sandboxEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (name: string) => {
    const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
    const colors: Record<string, string> = { ".txt": "bg-stone-100 text-stone-600", ".pdf": "bg-red-100 text-red-600", ".csv": "bg-emerald-100 text-emerald-600", ".docx": "bg-sky-100 text-sky-600" };
    return colors[ext] || "bg-stone-100 text-stone-600";
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="knowledge-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-knowledge-title">AI 與知識庫</h1>
        <p className="text-sm text-stone-500 mt-1">管理 AI 行為指令、知識庫文件與測試沙盒</p>
      </div>

      <Tabs defaultValue="prompt" className="space-y-4">
        <TabsList className="bg-white border border-stone-200 p-1 rounded-xl">
          <TabsTrigger value="prompt" className="text-xs rounded-lg" data-testid="tab-prompt">
            <Brain className="w-3.5 h-3.5 mr-1.5" />系統指令與知識庫
          </TabsTrigger>
          <TabsTrigger value="sandbox" className="text-xs rounded-lg" data-testid="tab-sandbox">
            <FlaskConical className="w-3.5 h-3.5 mr-1.5" />AI 測試沙盒
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prompt" className="space-y-4 mt-4">
          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center"><Brain className="w-4 h-4 text-violet-600" /></div>
              <div>
                <span className="text-sm font-semibold text-stone-800">系統指令 (System Prompt)</span>
                <p className="text-xs text-stone-500">定義 AI 客服助理的行為、語氣與回覆規則</p>
              </div>
            </div>
            <Textarea
              data-testid="textarea-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="輸入系統指令..."
              className="min-h-[160px] resize-y text-sm mt-3 bg-stone-50 border-stone-200"
            />
            <div className="flex justify-end mt-3">
              <Button onClick={handleSavePrompt} disabled={saving} data-testid="button-save-prompt" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl">
                <Save className="w-3.5 h-3.5 mr-1.5" />{saving ? "儲存中..." : "儲存指令"}
              </Button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><FileText className="w-4 h-4 text-emerald-600" /></div>
              <div>
                <span className="text-sm font-semibold text-stone-800">知識庫文件</span>
                <p className="text-xs text-stone-500">上傳文件作為 AI 回覆的參考知識</p>
              </div>
            </div>

            <div
              className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer ${dragOver ? "border-emerald-400 bg-emerald-50" : "border-stone-200 hover:border-stone-300"}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              data-testid="dropzone-upload"
            >
              <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-stone-100 flex items-center justify-center"><Upload className="w-6 h-6 text-stone-400" /></div>
              <p className="text-sm font-medium text-stone-600">{uploading ? "上傳中..." : "拖曳檔案至此或點擊上傳"}</p>
              <p className="text-xs text-stone-400 mt-1">支援拖曳 .pdf, .docx, .txt, .csv 格式 (最大 20MB)</p>
              <input ref={fileInputRef} type="file" accept=".txt,.pdf,.csv,.docx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ""; }} data-testid="input-file-upload" />
            </div>

            {filesLoading ? (
              <p className="text-sm text-stone-400 text-center py-4 mt-4">載入檔案列表...</p>
            ) : files.length === 0 ? (
              <p className="text-sm text-stone-400 text-center py-4 mt-4">尚未上傳任何文件</p>
            ) : (
              <div className="space-y-2 mt-4">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center gap-3 p-3 rounded-xl bg-stone-50 border border-stone-100" data-testid={`file-item-${file.id}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${getFileIcon(file.original_name)}`}><FileText className="w-4 h-4" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-stone-800 truncate">{file.original_name}</p>
                      <p className="text-xs text-stone-400">{formatFileSize(file.size)}</p>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => handleDeleteFile(file.id)} data-testid={`button-delete-file-${file.id}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="sandbox" className="mt-4">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center"><FlaskConical className="w-4 h-4 text-amber-600" /></div>
                <div>
                  <span className="text-sm font-semibold text-stone-800">AI 測試沙盒</span>
                  <p className="text-xs text-stone-500">使用真實 OpenAI API 測試系統指令效果</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                <AlertTriangle className="w-3 h-3" />
                此區僅供內部測試，不會發送真實 LINE 訊息
              </div>
            </div>

            <ScrollArea className="h-[400px] bg-[#faf9f5]">
              <div className="p-5 space-y-4">
                {sandboxMessages.length === 0 && (
                  <div className="text-center py-12">
                    <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-stone-100 flex items-center justify-center"><Bot className="w-8 h-8 text-stone-300" /></div>
                    <p className="text-sm text-stone-500">輸入訊息開始測試 AI 回覆效果</p>
                    <p className="text-xs text-stone-400 mt-1">系統將使用 OpenAI API 與目前的系統指令來回覆</p>
                  </div>
                )}
                {sandboxMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`flex items-end gap-2 max-w-[70%] ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                      <Avatar className="w-7 h-7 shrink-0">
                        <AvatarFallback className={msg.role === "user" ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-600"}>
                          {msg.role === "user" ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                        </AvatarFallback>
                      </Avatar>
                      <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                        msg.role === "user"
                          ? "bg-emerald-600 text-white rounded-br-md"
                          : msg.content.startsWith("⚠️")
                          ? "bg-red-50 text-red-700 rounded-bl-md border border-red-200"
                          : "bg-white text-stone-700 rounded-bl-md border border-stone-100"
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))}
                {sandboxLoading && (
                  <div className="flex justify-start">
                    <div className="flex items-end gap-2">
                      <Avatar className="w-7 h-7"><AvatarFallback className="bg-emerald-100 text-emerald-600"><Bot className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
                      <div className="bg-white rounded-2xl rounded-bl-md px-4 py-3 shadow-sm border border-stone-100">
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1">
                            <span className="w-2 h-2 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-2 h-2 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-2 h-2 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "300ms" }} />
                          </div>
                          <span className="text-xs text-stone-400">AI 思考中...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={sandboxEndRef} />
              </div>
            </ScrollArea>

            <div className="p-4 border-t border-stone-200 bg-white">
              <div className="flex gap-2">
                <Input
                  data-testid="input-sandbox-message"
                  placeholder="輸入測試訊息..."
                  value={sandboxInput}
                  onChange={(e) => setSandboxInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSandboxSend(); } }}
                  disabled={sandboxLoading}
                  className="bg-stone-50 border-stone-200"
                />
                <Button onClick={handleSandboxSend} disabled={!sandboxInput.trim() || sandboxLoading} data-testid="button-sandbox-send" className="bg-emerald-600 hover:bg-emerald-700 text-white px-4">
                  <Send className="w-4 h-4 mr-1.5" />測試
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
