import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  Brain, Upload, Trash2, FileText, Save, FlaskConical, Send, Bot, User,
  AlertTriangle, ShoppingCart, Plus, Pencil, ExternalLink, Lightbulb, Tag,
  Paperclip, ImageIcon, Film, X, Loader2, Building2, RotateCcw, Eye,
  Database, Wrench, Zap, BookOpen, Palette, MessageSquare,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useToast } from "@/hooks/use-toast";
import type { Setting, KnowledgeFile, MarketingRule, ImageAsset } from "@shared/schema";

interface SandboxMessage {
  role: "user" | "ai" | "system";
  content: string;
  fileUrl?: string;
  fileType?: "image" | "video";
  toolLog?: string[];
  imageUrl?: string;
}

interface PromptPreview {
  brand_name: string;
  brand_prompt: string;
  global_prompt: string;
  full_prompt_length: number;
  full_prompt_preview: string;
  context_stats: {
    knowledge_files: number;
    marketing_rules: number;
    image_assets: number;
    channels: number;
  };
}

export default function KnowledgePage() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [brandPrompt, setBrandPrompt] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingBrandPrompt, setSavingBrandPrompt] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sandboxMessages, setSandboxMessages] = useState<SandboxMessage[]>([]);
  const [sandboxInput, setSandboxInput] = useState("");
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<MarketingRule | null>(null);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [rulePitch, setRulePitch] = useState("");
  const [ruleUrl, setRuleUrl] = useState("");
  const [ruleSaving, setRuleSaving] = useState(false);
  const [sandboxUploading, setSandboxUploading] = useState(false);
  const [sandboxPendingFile, setSandboxPendingFile] = useState<{ file: File; preview: string; type: "image" | "video" } | null>(null);
  const [showPromptPreview, setShowPromptPreview] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreview | null>(null);
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false);
  const [imageAssetUploading, setImageAssetUploading] = useState(false);
  const [editingAsset, setEditingAsset] = useState<ImageAsset | null>(null);
  const [assetForm, setAssetForm] = useState({ display_name: "", description: "", keywords: "" });
  const [showAssetDialog, setShowAssetDialog] = useState(false);
  const [assetSaving, setAssetSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageAssetInputRef = useRef<HTMLInputElement>(null);
  const sandboxFileRef = useRef<HTMLInputElement>(null);
  const sandboxEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedBrandId, selectedBrand } = useBrand();

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  useEffect(() => {
    if (!promptLoaded && settings.length > 0) {
      const prompt = settings.find((s) => s.key === "system_prompt");
      if (prompt) { setSystemPrompt(prompt.value); setPromptLoaded(true); }
    }
  }, [settings, promptLoaded]);

  useEffect(() => {
    if (selectedBrand) {
      setBrandPrompt(selectedBrand.system_prompt || "");
    }
  }, [selectedBrandId, selectedBrand]);

  const { data: files = [], isLoading: filesLoading } = useQuery<KnowledgeFile[]>({
    queryKey: ["/api/knowledge-files"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const { data: marketingRules = [] } = useQuery<MarketingRule[]>({
    queryKey: ["/api/marketing-rules"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const { data: imageAssets = [] } = useQuery<ImageAsset[]>({
    queryKey: ["/api/image-assets"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const brandFiles = files.filter(f => !selectedBrandId || f.brand_id === selectedBrandId || f.brand_id === null);
  const brandRules = marketingRules.filter(r => !selectedBrandId || (r as any).brand_id === selectedBrandId || (r as any).brand_id === null);
  const brandAssets = imageAssets.filter(a => !selectedBrandId || a.brand_id === selectedBrandId || a.brand_id === null);

  const handleSavePrompt = async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/settings", { key: "system_prompt", value: systemPrompt });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "儲存成功", description: "全域系統指令已更新" });
    } catch (_e) {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleSaveBrandPrompt = async () => {
    if (!selectedBrandId) return;
    setSavingBrandPrompt(true);
    try {
      await apiRequest("PUT", `/api/brands/${selectedBrandId}`, { system_prompt: brandPrompt });
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      toast({ title: "儲存成功", description: `${selectedBrand?.name || "品牌"} 的 AI 指令已更新` });
    } catch (_e) {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally { setSavingBrandPrompt(false); }
  };

  const handleUploadFile = useCallback(async (file: File) => {
    const allowed = [".txt", ".pdf", ".csv", ".docx", ".xlsx", ".md"];
    const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg", ".ico"];
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (imageExts.includes(ext)) {
      toast({ title: "圖片檔案不可上傳至知識庫", description: "如需上傳圖片素材，請至「圖片素材庫」分頁", variant: "destructive" });
      return;
    }
    if (!allowed.includes(ext)) {
      toast({ title: "檔案格式錯誤", description: "僅支援 .txt, .pdf, .csv, .docx, .xlsx, .md", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (selectedBrandId) formData.append("brand_id", String(selectedBrandId));
      const res = await fetch("/api/knowledge-files", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "上傳成功", description: `${file.name} 已上傳至 ${selectedBrand?.name || "全域"}` });
    } catch (_e) { toast({ title: "上傳失敗", variant: "destructive" }); }
    finally { setUploading(false); }
  }, [queryClient, toast, selectedBrandId, selectedBrand]);

  const handleDeleteFile = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/knowledge-files/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "刪除成功" });
    } catch (_e) { toast({ title: "刪除失敗", variant: "destructive" }); }
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
    const updatedMessages = [...sandboxMessages, { role: "user" as const, content: userMsg }];
    setSandboxMessages(updatedMessages);
    setSandboxInput("");
    setSandboxLoading(true);
    try {
      const history = updatedMessages.filter(m => m.role !== "system").slice(-20).map((m) => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.content,
      }));
      const res = await fetch("/api/sandbox/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg, history, brand_id: selectedBrandId }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setSandboxMessages((prev) => [...prev, { role: "ai", content: `⚠️ ${data.message}` }]);
      } else {
        if (data.tool_log && data.tool_log.length > 0) {
          setSandboxMessages((prev) => [...prev, { role: "system", content: "🔧 AI 工具呼叫紀錄", toolLog: data.tool_log }]);
        }
        setSandboxMessages((prev) => [...prev, { role: "ai", content: data.reply, imageUrl: data.image_url }]);
        if (data.transferred) {
          setSandboxMessages((prev) => [...prev, { role: "system", content: `⚡ AI 觸發「轉接真人客服」\n正式環境中，此聯絡人會被標記為「需人工處理」並暫停 AI 回覆。\n轉接原因：${data.transfer_reason || "未提供"}` }]);
        }
      }
    } catch (_e) {
      setSandboxMessages((prev) => [...prev, { role: "ai", content: "⚠️ 連線失敗，請稍後再試。" }]);
    } finally {
      setSandboxLoading(false);
      setTimeout(() => sandboxEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  };

  const handleLoadPromptPreview = async () => {
    setPromptPreviewLoading(true);
    try {
      const url = selectedBrandId ? `/api/sandbox/prompt-preview?brand_id=${selectedBrandId}` : "/api/sandbox/prompt-preview";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        toast({ title: "載入提示詞失敗", description: `HTTP ${res.status}`, variant: "destructive" });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setPromptPreview(data);
        setShowPromptPreview(true);
      } else {
        toast({ title: "載入提示詞失敗", description: data.message || "未知錯誤", variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "載入失敗", description: "無法連線至伺服器", variant: "destructive" });
    } finally {
      setPromptPreviewLoading(false);
    }
  };

  const handleSandboxFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
    const videoExts = ["mp4", "mov", "avi", "webm"];
    if (!imageExts.includes(ext) && !videoExts.includes(ext)) {
      toast({ title: "不支援的檔案格式", description: "支援圖片（JPG/PNG/GIF/WebP）和影片（MP4/MOV）", variant: "destructive" });
      return;
    }
    const type = videoExts.includes(ext) ? "video" as const : "image" as const;
    const preview = type === "image" ? URL.createObjectURL(file) : "";
    setSandboxPendingFile({ file, preview, type });
    if (sandboxFileRef.current) sandboxFileRef.current.value = "";
  };

  const handleSandboxUpload = async () => {
    if (!sandboxPendingFile || sandboxUploading) return;
    const { file, type } = sandboxPendingFile;
    setSandboxUploading(true);
    setSandboxMessages(prev => [...prev, {
      role: "user",
      content: type === "image" ? `[上傳圖片] ${file.name}` : `[上傳影片] ${file.name}`,
      fileUrl: sandboxPendingFile.preview || undefined,
      fileType: type,
    }]);
    setSandboxPendingFile(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (selectedBrandId) formData.append("brand_id", String(selectedBrandId));
      const history = sandboxMessages.filter(m => m.role !== "system").slice(-20).map(m => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.content,
      }));
      formData.append("history", JSON.stringify(history));

      const res = await fetch("/api/sandbox/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setSandboxMessages(prev => [...prev, { role: "ai", content: `⚠️ ${data.message}` }]);
      } else {
        if (data.tool_log && data.tool_log.length > 0) {
          setSandboxMessages(prev => [...prev, { role: "system", content: "🔧 AI 工具呼叫紀錄", toolLog: data.tool_log }]);
        }
        setSandboxMessages(prev => [...prev, { role: "ai", content: data.reply }]);
        if (data.transferred) {
          setSandboxMessages(prev => [...prev, { role: "system", content: `⚡ AI 觸發「轉接真人客服」\n正式環境中，此聯絡人會被標記為「需人工處理」並暫停 AI 回覆。\n轉接原因：${data.transfer_reason || "未提供"}` }]);
        }
      }
    } catch (_e) {
      setSandboxMessages(prev => [...prev, { role: "ai", content: "⚠️ 上傳失敗，請稍後再試。" }]);
    } finally {
      setSandboxUploading(false);
      setTimeout(() => sandboxEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  };

  const openAddRule = () => {
    setEditingRule(null);
    setRuleKeyword(""); setRulePitch(""); setRuleUrl("");
    setShowRuleDialog(true);
  };

  const openEditRule = (rule: MarketingRule) => {
    setEditingRule(rule);
    setRuleKeyword(rule.keyword);
    setRulePitch(rule.pitch);
    setRuleUrl(rule.url);
    setShowRuleDialog(true);
  };

  const handleSaveRule = async () => {
    if (!ruleKeyword.trim()) {
      toast({ title: "關鍵字為必填", variant: "destructive" });
      return;
    }
    setRuleSaving(true);
    try {
      if (editingRule) {
        await apiRequest("PUT", `/api/marketing-rules/${editingRule.id}`, { keyword: ruleKeyword.trim(), pitch: rulePitch.trim(), url: ruleUrl.trim() });
      } else {
        await apiRequest("POST", "/api/marketing-rules", { keyword: ruleKeyword.trim(), pitch: rulePitch.trim(), url: ruleUrl.trim() });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/marketing-rules"] });
      toast({ title: editingRule ? "更新成功" : "新增成功" });
      setShowRuleDialog(false);
    } catch (_e) { toast({ title: "操作失敗", variant: "destructive" }); }
    finally { setRuleSaving(false); }
  };

  const handleDeleteRule = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/marketing-rules/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/marketing-rules"] });
      toast({ title: "刪除成功" });
    } catch (_e) { toast({ title: "刪除失敗", variant: "destructive" }); }
  };

  const handleUploadImageAsset = useCallback(async (file: File) => {
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!allowed.includes(ext)) {
      toast({ title: "格式錯誤", description: "僅支援 .jpg, .jpeg, .png, .gif, .webp", variant: "destructive" });
      return;
    }
    setImageAssetUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("display_name", file.name);
      if (selectedBrandId) formData.append("brand_id", String(selectedBrandId));
      const res = await fetch("/api/image-assets", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      queryClient.invalidateQueries({ queryKey: ["/api/image-assets"] });
      toast({ title: "上傳成功", description: `${file.name} 已加入素材庫` });
    } catch (_e) { toast({ title: "上傳失敗", variant: "destructive" }); }
    finally { setImageAssetUploading(false); }
  }, [queryClient, toast, selectedBrandId]);

  const handleEditAsset = (asset: ImageAsset) => {
    setEditingAsset(asset);
    setAssetForm({ display_name: asset.display_name, description: asset.description, keywords: asset.keywords });
    setShowAssetDialog(true);
  };

  const handleSaveAsset = async () => {
    if (!editingAsset) return;
    setAssetSaving(true);
    try {
      await apiRequest("PUT", `/api/image-assets/${editingAsset.id}`, assetForm);
      queryClient.invalidateQueries({ queryKey: ["/api/image-assets"] });
      toast({ title: "更新成功" });
      setShowAssetDialog(false);
    } catch (_e) { toast({ title: "更新失敗", variant: "destructive" }); }
    finally { setAssetSaving(false); }
  };

  const handleDeleteAsset = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/image-assets/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/image-assets"] });
      toast({ title: "刪除成功" });
    } catch (_e) { toast({ title: "刪除失敗", variant: "destructive" }); }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (name: string) => {
    const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
    const colors: Record<string, string> = { ".txt": "bg-stone-100 text-stone-600", ".pdf": "bg-red-100 text-red-600", ".csv": "bg-emerald-100 text-emerald-600", ".docx": "bg-sky-100 text-sky-600", ".xlsx": "bg-green-100 text-green-600", ".md": "bg-violet-100 text-violet-600" };
    return colors[ext] || "bg-stone-100 text-stone-600";
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="knowledge-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-stone-800" data-testid="text-knowledge-title">AI 與知識庫</h1>
          <p className="text-sm text-stone-500 mt-1">管理 AI 行為指令、知識庫文件、產品導購與測試沙盒</p>
        </div>
        {selectedBrand && (
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-1.5" data-testid="text-knowledge-brand">
            <Building2 className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-xs font-medium text-emerald-700">{selectedBrand.name}</span>
          </div>
        )}
      </div>

      <Tabs defaultValue="prompt" className="space-y-4">
        <TabsList className="bg-white border border-stone-200 p-1 rounded-xl">
          <TabsTrigger value="prompt" className="text-xs rounded-lg" data-testid="tab-prompt">
            <Brain className="w-3.5 h-3.5 mr-1.5" />系統指令與知識庫
          </TabsTrigger>
          <TabsTrigger value="images" className="text-xs rounded-lg" data-testid="tab-images">
            <ImageIcon className="w-3.5 h-3.5 mr-1.5" />圖片素材庫
          </TabsTrigger>
          <TabsTrigger value="marketing" className="text-xs rounded-lg" data-testid="tab-marketing">
            <ShoppingCart className="w-3.5 h-3.5 mr-1.5" />產品導購庫
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
                <span className="text-sm font-semibold text-stone-800">全域系統指令 (System Prompt)</span>
                <p className="text-xs text-stone-500">所有品牌共用的基本 AI 行為規則，品牌專屬指令會疊加在此之上</p>
              </div>
            </div>
            <Textarea
              data-testid="textarea-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="輸入全域系統指令..."
              className="min-h-[120px] resize-y text-sm mt-3 bg-stone-50 border-stone-200"
            />
            <div className="flex justify-end mt-3">
              <Button onClick={handleSavePrompt} disabled={saving} data-testid="button-save-prompt" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl">
                <Save className="w-3.5 h-3.5 mr-1.5" />{saving ? "儲存中..." : "儲存全域指令"}
              </Button>
            </div>
          </div>

          {selectedBrand && (
            <div className="bg-white rounded-2xl border border-emerald-200 p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><Building2 className="w-4 h-4 text-emerald-600" /></div>
                <div>
                  <span className="text-sm font-semibold text-stone-800">{selectedBrand.name} 專屬 AI 指令</span>
                  <p className="text-xs text-stone-500">此品牌的客服 AI 人設、語調與專屬回覆規則</p>
                </div>
              </div>
              <Textarea
                data-testid="textarea-brand-prompt"
                value={brandPrompt}
                onChange={(e) => setBrandPrompt(e.target.value)}
                placeholder={`定義 ${selectedBrand.name} 的 AI 角色與回覆風格...`}
                className="min-h-[120px] resize-y text-sm mt-3 bg-emerald-50/50 border-emerald-200"
              />
              <div className="flex justify-end mt-3">
                <Button onClick={handleSaveBrandPrompt} disabled={savingBrandPrompt} data-testid="button-save-brand-prompt" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-xl">
                  <Save className="w-3.5 h-3.5 mr-1.5" />{savingBrandPrompt ? "儲存中..." : `儲存 ${selectedBrand.name} 指令`}
                </Button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><FileText className="w-4 h-4 text-emerald-600" /></div>
              <div>
                <span className="text-sm font-semibold text-stone-800">知識庫文件</span>
                <p className="text-xs text-stone-500">
                  上傳文件作為 AI 回覆的參考知識
                  {selectedBrand && <span className="text-emerald-600"> (上傳至 {selectedBrand.name})</span>}
                </p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-start gap-2" data-testid="tip-csv-format">
              <Lightbulb className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 leading-relaxed">
                <span className="font-semibold">確保 AI 報價精準的黃金格式：</span>強烈建議將產品建置成 .csv 表格 (包含產品名、價格、網址、特色) 上傳。請勿上傳無排版的長篇 PDF，以免 AI 判斷錯誤。
              </p>
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
              <p className="text-xs text-stone-400 mt-1">支援 .xlsx, .docx, .pdf, .csv, .txt, .md 格式 (最大 20MB，不接受圖片)</p>
              <input ref={fileInputRef} type="file" accept=".txt,.pdf,.csv,.docx,.xlsx,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ""; }} data-testid="input-file-upload" />
            </div>

            {filesLoading ? (
              <p className="text-sm text-stone-400 text-center py-4 mt-4">載入檔案列表...</p>
            ) : brandFiles.length === 0 ? (
              <p className="text-sm text-stone-400 text-center py-4 mt-4">尚未上傳任何文件</p>
            ) : (
              <div className="space-y-2 mt-4">
                {brandFiles.map((file) => (
                  <div key={file.id} className="flex items-center gap-3 p-3 rounded-xl bg-stone-50 border border-stone-100" data-testid={`file-item-${file.id}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${getFileIcon(file.original_name)}`}><FileText className="w-4 h-4" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-stone-800 truncate">{file.original_name}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-stone-400">{formatFileSize(file.size)}</p>
                        {file.brand_id ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">品牌專屬</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500">全域</span>
                        )}
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => handleDeleteFile(file.id)} data-testid={`button-delete-file-${file.id}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="images" className="mt-4">
          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-image-assets">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-pink-100 flex items-center justify-center"><ImageIcon className="w-4 h-4 text-pink-600" /></div>
                <div>
                  <span className="text-sm font-semibold text-stone-800">圖片素材庫</span>
                  <p className="text-xs text-stone-500">
                    上傳圖片讓 AI 可以在對話中自動發送給客戶
                    {selectedBrand && <span className="text-emerald-600"> ({selectedBrand.name})</span>}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 mb-4 flex items-start gap-2">
              <Lightbulb className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
              <p className="text-xs text-sky-800 leading-relaxed">
                AI 會根據客戶問題自動判斷是否需要發送圖片。為每張圖片設定「顯示名稱」「說明」「關鍵字」可以幫助 AI 更精準地選圖。
              </p>
            </div>

            <div
              className="border-2 border-dashed rounded-2xl p-6 text-center transition-all cursor-pointer border-stone-200 hover:border-pink-300 mb-4"
              onClick={() => imageAssetInputRef.current?.click()}
              data-testid="dropzone-image-upload"
            >
              <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-pink-50 flex items-center justify-center"><Upload className="w-5 h-5 text-pink-400" /></div>
              <p className="text-sm font-medium text-stone-600">{imageAssetUploading ? "上傳中..." : "點擊上傳圖片素材"}</p>
              <p className="text-xs text-stone-400 mt-1">支援 .jpg, .png, .gif, .webp (最大 10MB)</p>
              <input ref={imageAssetInputRef} type="file" accept=".jpg,.jpeg,.png,.gif,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadImageAsset(f); e.target.value = ""; }} data-testid="input-image-asset-upload" />
            </div>

            {brandAssets.length === 0 ? (
              <p className="text-sm text-stone-400 text-center py-4">尚未上傳任何圖片素材</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {brandAssets.map((asset) => (
                  <div key={asset.id} className="rounded-xl border border-stone-200 overflow-hidden bg-stone-50 group" data-testid={`image-asset-${asset.id}`}>
                    <div className="aspect-square bg-stone-100 relative">
                      <img src={`/api/image-assets/file/${asset.filename}`} alt={asset.display_name} className="w-full h-full object-cover" loading="lazy" />
                      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => handleEditAsset(asset)} className="w-6 h-6 rounded-lg bg-white/90 border border-stone-200 flex items-center justify-center hover:bg-white" data-testid={`button-edit-asset-${asset.id}`}><Pencil className="w-3 h-3 text-stone-600" /></button>
                        <button onClick={() => handleDeleteAsset(asset.id)} className="w-6 h-6 rounded-lg bg-white/90 border border-red-200 flex items-center justify-center hover:bg-red-50" data-testid={`button-delete-asset-${asset.id}`}><Trash2 className="w-3 h-3 text-red-500" /></button>
                      </div>
                    </div>
                    <div className="p-2">
                      <p className="text-xs font-medium text-stone-700 truncate" data-testid={`text-asset-name-${asset.id}`}>{asset.display_name}</p>
                      {asset.description && <p className="text-xs text-stone-400 truncate mt-0.5">{asset.description}</p>}
                      {asset.keywords && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {asset.keywords.split(",").map((kw, i) => (
                            <span key={i} className="text-xs bg-pink-50 text-pink-600 rounded px-1.5 py-0.5">{kw.trim()}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <Dialog open={showAssetDialog} onOpenChange={setShowAssetDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-bold text-stone-800">編輯圖片素材資訊</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">顯示名稱</label>
                <Input data-testid="input-asset-display-name" value={assetForm.display_name} onChange={(e) => setAssetForm(f => ({ ...f, display_name: e.target.value }))} placeholder="例如：巴斯克蛋糕特色圖" className="bg-stone-50 border-stone-200" />
              </div>
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">說明</label>
                <Input data-testid="input-asset-description" value={assetForm.description} onChange={(e) => setAssetForm(f => ({ ...f, description: e.target.value }))} placeholder="例如：展示巴斯克蛋糕的製作過程與口感" className="bg-stone-50 border-stone-200" />
              </div>
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">關鍵字 (逗號分隔)</label>
                <Input data-testid="input-asset-keywords" value={assetForm.keywords} onChange={(e) => setAssetForm(f => ({ ...f, keywords: e.target.value }))} placeholder="例如：巴斯克,蛋糕,甜點,推薦" className="bg-stone-50 border-stone-200" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowAssetDialog(false)} className="text-xs">取消</Button>
              <Button onClick={handleSaveAsset} disabled={assetSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-save-asset">
                {assetSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1" />}
                更新
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <TabsContent value="marketing" className="mt-4">
          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-marketing-rules">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center"><ShoppingCart className="w-4 h-4 text-orange-600" /></div>
                <div>
                  <span className="text-sm font-semibold text-stone-800">產品導購與快捷回覆庫</span>
                  <p className="text-xs text-stone-500">設定觸發關鍵字，AI 將自動推薦產品並附上購買連結</p>
                </div>
              </div>
              <Button onClick={openAddRule} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-rule">
                <Plus className="w-3.5 h-3.5 mr-1.5" />新增導購規則
              </Button>
            </div>

            {brandRules.length === 0 ? (
              <div className="text-center py-8">
                <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-stone-100 flex items-center justify-center"><ShoppingCart className="w-7 h-7 text-stone-300" /></div>
                <p className="text-sm text-stone-500">尚未建立導購規則</p>
                <p className="text-xs text-stone-400 mt-1">新增規則讓 AI 自動推薦產品給客戶</p>
              </div>
            ) : (
              <div className="border border-stone-200 rounded-xl overflow-hidden">
                <div className="grid grid-cols-[1fr_2fr_auto_auto] gap-4 px-4 py-2.5 bg-stone-50 border-b border-stone-200">
                  <span className="text-xs font-semibold text-stone-500">觸發關鍵字 / 產品</span>
                  <span className="text-xs font-semibold text-stone-500">推廣話術</span>
                  <span className="text-xs font-semibold text-stone-500">結帳連結</span>
                  <span className="text-xs font-semibold text-stone-500">操作</span>
                </div>
                <div className="divide-y divide-stone-100">
                  {brandRules.map((rule) => (
                    <div key={rule.id} className="grid grid-cols-[1fr_2fr_auto_auto] gap-4 px-4 py-3 items-center hover:bg-stone-50 transition-colors" data-testid={`rule-item-${rule.id}`}>
                      <div className="flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                        <span className="text-sm font-medium text-stone-800 truncate">{rule.keyword}</span>
                      </div>
                      <p className="text-xs text-stone-600 line-clamp-2 leading-relaxed">{rule.pitch}</p>
                      <div>
                        {rule.url ? (
                          <a href={rule.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700">
                            <ExternalLink className="w-3 h-3" />連結
                          </a>
                        ) : (
                          <span className="text-xs text-stone-400">—</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" onClick={() => openEditRule(rule)} data-testid={`button-edit-rule-${rule.id}`} className="h-7 w-7 text-stone-400 hover:text-emerald-600 hover:bg-emerald-50">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDeleteRule(rule.id)} data-testid={`button-delete-rule-${rule.id}`} className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="sandbox" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-stone-200 p-3 flex items-center gap-2.5" data-testid="sandbox-stat-persona">
              <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0"><Brain className="w-4 h-4 text-violet-600" /></div>
              <div className="min-w-0">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide">人設/人格</p>
                <p className="text-xs font-semibold text-stone-800 truncate">{selectedBrand?.name || "全域"}</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-stone-200 p-3 flex items-center gap-2.5" data-testid="sandbox-stat-knowledge">
              <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0"><BookOpen className="w-4 h-4 text-emerald-600" /></div>
              <div className="min-w-0">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide">知識庫文件</p>
                <p className="text-xs font-semibold text-stone-800">{brandFiles.length} 份</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-stone-200 p-3 flex items-center gap-2.5" data-testid="sandbox-stat-rules">
              <div className="w-9 h-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0"><ShoppingCart className="w-4 h-4 text-orange-600" /></div>
              <div className="min-w-0">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide">導購規則</p>
                <p className="text-xs font-semibold text-stone-800">{brandRules.length} 筆</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-stone-200 p-3 flex items-center gap-2.5" data-testid="sandbox-stat-images">
              <div className="w-9 h-9 rounded-lg bg-pink-100 flex items-center justify-center shrink-0"><Palette className="w-4 h-4 text-pink-600" /></div>
              <div className="min-w-0">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide">圖片素材</p>
                <p className="text-xs font-semibold text-stone-800">{brandAssets.length} 張</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center"><FlaskConical className="w-4 h-4 text-amber-600" /></div>
                <div>
                  <span className="text-sm font-semibold text-stone-800">AI 擬真測試沙盒</span>
                  <p className="text-xs text-stone-500">
                    使用真實 OpenAI API + {selectedBrand ? `${selectedBrand.name} 品牌人格` : "全域指令"} + 完整工具鏈測試
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleLoadPromptPreview}
                  disabled={promptPreviewLoading}
                  className="text-xs h-7 px-2.5 border-violet-200 text-violet-600 hover:bg-violet-50"
                  data-testid="button-preview-prompt"
                >
                  {promptPreviewLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Eye className="w-3 h-3 mr-1" />}
                  查看完整提示詞
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSandboxMessages([])}
                  className="text-xs h-7 px-2.5 border-stone-200 text-stone-500 hover:bg-stone-50"
                  data-testid="button-sandbox-reset"
                >
                  <RotateCcw className="w-3 h-3 mr-1" />重置對話
                </Button>
              </div>
            </div>

            {selectedBrand?.system_prompt && (
              <div className="px-5 py-2 bg-violet-50/50 border-b border-violet-100 flex items-start gap-2">
                <Brain className="w-3.5 h-3.5 text-violet-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-violet-700 leading-relaxed line-clamp-2">
                  <span className="font-semibold">品牌人設：</span>{selectedBrand.system_prompt.substring(0, 150)}{selectedBrand.system_prompt.length > 150 ? "..." : ""}
                </p>
              </div>
            )}

            <ScrollArea className="h-[420px] bg-[#faf9f5]">
              <div className="p-5 space-y-4">
                {sandboxMessages.length === 0 && (
                  <div className="text-center py-10">
                    <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-stone-100 flex items-center justify-center"><Bot className="w-8 h-8 text-stone-300" /></div>
                    <p className="text-sm font-medium text-stone-600">擬真 AI 客服測試</p>
                    <p className="text-xs text-stone-400 mt-1 max-w-sm mx-auto">
                      模擬真實客戶對話，AI 將以 {selectedBrand ? `「${selectedBrand.name}」品牌人格` : "全域指令"} 回覆，支援訂單查詢、圖片分析、轉接真人等完整功能
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 mt-4">
                      {["你們有什麼推薦的甜點？", "我想查訂單進度", "這個蛋糕可以退嗎？", "幫我找真人客服"].map((q, i) => (
                        <button
                          key={i}
                          onClick={() => { setSandboxInput(q); }}
                          className="text-xs px-3 py-1.5 rounded-full bg-white border border-stone-200 text-stone-600 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 transition-colors"
                          data-testid={`button-sandbox-quickstart-${i}`}
                        >
                          <MessageSquare className="w-3 h-3 inline mr-1" />{q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {sandboxMessages.map((msg, i) => (
                  <div key={i}>
                    {msg.role === "system" ? (
                      <div className="flex justify-center">
                        <div className="max-w-[85%] rounded-xl px-3 py-2 bg-amber-50 border border-amber-200 text-xs">
                          {msg.toolLog ? (
                            <div>
                              <div className="flex items-center gap-1.5 text-amber-700 font-semibold mb-1">
                                <Wrench className="w-3 h-3" />{msg.content}
                              </div>
                              <div className="space-y-0.5 font-mono text-[10px] text-amber-600 bg-amber-100/50 rounded-lg p-2">
                                {msg.toolLog.map((log, j) => (
                                  <div key={j} className={log.startsWith(">>>") ? "text-red-600 font-semibold" : ""}>{log}</div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-1.5 text-amber-700 whitespace-pre-wrap">
                              <Zap className="w-3 h-3 shrink-0 mt-0.5" />
                              <span>{msg.content}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`flex items-end gap-2 max-w-[75%] ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                          <Avatar className="w-7 h-7 shrink-0">
                            <AvatarFallback className={msg.role === "user" ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-600"}>
                              {msg.role === "user" ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className={`text-[10px] mb-0.5 ${msg.role === "user" ? "text-right text-stone-400" : "text-left text-stone-400"}`}>
                              {msg.role === "user" ? "模擬客戶" : `AI 客服 (${selectedBrand?.name || "全域"})`}
                            </div>
                            <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                              msg.role === "user"
                                ? "bg-emerald-600 text-white rounded-br-md"
                                : msg.content.startsWith("⚠️")
                                ? "bg-red-50 text-red-700 rounded-bl-md border border-red-200"
                                : "bg-white text-stone-700 rounded-bl-md border border-stone-100"
                            }`}>
                              {msg.fileType === "image" && msg.fileUrl && (
                                <img src={msg.fileUrl} alt="uploaded" className="max-w-[200px] rounded-lg mb-2" />
                              )}
                              {msg.fileType === "video" && (
                                <div className="flex items-center gap-2 mb-1 bg-black/5 rounded-lg p-2">
                                  <Film className="w-4 h-4" />
                                  <span className="text-xs opacity-80">影片檔案</span>
                                </div>
                              )}
                              {msg.content}
                            </div>
                            {msg.imageUrl && (
                              <div className="mt-2">
                                <img src={msg.imageUrl} alt="AI sent" className="max-w-[200px] rounded-lg border border-stone-200" />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {sandboxLoading && (
                  <div className="flex justify-start">
                    <div className="flex items-end gap-2">
                      <Avatar className="w-7 h-7"><AvatarFallback className="bg-emerald-100 text-emerald-600"><Bot className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
                      <div>
                        <div className="text-[10px] mb-0.5 text-stone-400">AI 客服 ({selectedBrand?.name || "全域"})</div>
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
                  </div>
                )}
                <div ref={sandboxEndRef} />
              </div>
            </ScrollArea>

            {sandboxUploading && (
              <div className="flex justify-start px-5 pb-2">
                <div className="flex items-end gap-2">
                  <Avatar className="w-7 h-7"><AvatarFallback className="bg-emerald-100 text-emerald-600"><Bot className="w-3.5 h-3.5" /></AvatarFallback></Avatar>
                  <div className="bg-white rounded-2xl rounded-bl-md px-4 py-3 shadow-sm border border-stone-100">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
                      <span className="text-xs text-stone-400">AI 分析檔案中...</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="p-4 border-t border-stone-200 bg-white">
              {sandboxPendingFile && (
                <div className="mb-3 flex items-center gap-2 bg-stone-50 rounded-xl p-2.5 border border-stone-200">
                  {sandboxPendingFile.type === "image" && sandboxPendingFile.preview ? (
                    <img src={sandboxPendingFile.preview} alt="preview" className="w-12 h-12 object-cover rounded-lg" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-stone-200 flex items-center justify-center"><Film className="w-5 h-5 text-stone-500" /></div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-stone-700 truncate">{sandboxPendingFile.file.name}</p>
                    <p className="text-[10px] text-stone-400">{(sandboxPendingFile.file.size / 1024 / 1024).toFixed(1)} MB · {sandboxPendingFile.type === "image" ? "圖片" : "影片"}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" onClick={handleSandboxUpload} disabled={sandboxUploading} data-testid="button-sandbox-upload-send" className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
                      <Send className="w-3 h-3 mr-1" />傳送
                    </Button>
                    <button onClick={() => setSandboxPendingFile(null)} className="text-stone-400 hover:text-stone-600"><X className="w-4 h-4" /></button>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => sandboxFileRef.current?.click()} className="shrink-0 w-10 h-10 rounded-xl bg-stone-100 hover:bg-stone-200 flex items-center justify-center transition-colors" data-testid="button-sandbox-attach">
                  <Paperclip className="w-4 h-4 text-stone-500" />
                </button>
                <input ref={sandboxFileRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleSandboxFileSelect} />
                <Input
                  data-testid="input-sandbox-message"
                  value={sandboxInput}
                  onChange={(e) => setSandboxInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSandboxSend(); } }}
                  placeholder="模擬客戶訊息... (例如：我想查訂單、推薦甜點、我要退貨)"
                  className="bg-stone-50 border-stone-200"
                />
                <Button onClick={handleSandboxSend} disabled={!sandboxInput.trim() || sandboxLoading} data-testid="button-sandbox-send" className="bg-emerald-600 hover:bg-emerald-700 text-white shrink-0">
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={showRuleDialog} onOpenChange={setShowRuleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-800">{editingRule ? "編輯導購規則" : "新增導購規則"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">觸發關鍵字 / 產品名稱 *</label>
              <Input data-testid="input-rule-keyword" value={ruleKeyword} onChange={(e) => setRuleKeyword(e.target.value)} placeholder="例：紅絲絨蛋糕" className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">推廣話術</label>
              <Textarea data-testid="textarea-rule-pitch" value={rulePitch} onChange={(e) => setRulePitch(e.target.value)} placeholder="AI 會在回覆中自然帶入這段推廣話術..." className="min-h-[80px] resize-y text-sm bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">結帳/購買連結</label>
              <Input data-testid="input-rule-url" value={ruleUrl} onChange={(e) => setRuleUrl(e.target.value)} placeholder="https://..." className="bg-stone-50 border-stone-200" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowRuleDialog(false)} className="text-xs">取消</Button>
            <Button onClick={handleSaveRule} disabled={ruleSaving} data-testid="button-save-rule" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs">
              {ruleSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1" />}
              {editingRule ? "更新" : "建立"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPromptPreview} onOpenChange={setShowPromptPreview}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-stone-800 flex items-center gap-2">
              <Eye className="w-4 h-4 text-violet-600" />
              AI 完整提示詞預覽 — {promptPreview?.brand_name || "全域"}
            </DialogTitle>
            <DialogDescription className="text-xs text-stone-500">檢視送入 OpenAI 的完整提示詞，包含品牌人設、知識庫、導購規則等所有上下文</DialogDescription>
          </DialogHeader>
          {promptPreview && (
            <div className="space-y-4 overflow-y-auto max-h-[60vh] pr-1">
              <div className="grid grid-cols-4 gap-2">
                <div className="bg-emerald-50 rounded-lg p-2 text-center border border-emerald-200">
                  <p className="text-lg font-bold text-emerald-700">{promptPreview.context_stats.knowledge_files}</p>
                  <p className="text-[10px] text-emerald-600">知識庫</p>
                </div>
                <div className="bg-orange-50 rounded-lg p-2 text-center border border-orange-200">
                  <p className="text-lg font-bold text-orange-700">{promptPreview.context_stats.marketing_rules}</p>
                  <p className="text-[10px] text-orange-600">導購規則</p>
                </div>
                <div className="bg-pink-50 rounded-lg p-2 text-center border border-pink-200">
                  <p className="text-lg font-bold text-pink-700">{promptPreview.context_stats.image_assets}</p>
                  <p className="text-[10px] text-pink-600">圖片素材</p>
                </div>
                <div className="bg-violet-50 rounded-lg p-2 text-center border border-violet-200">
                  <p className="text-lg font-bold text-violet-700">{Math.round(promptPreview.full_prompt_length / 1000)}K</p>
                  <p className="text-[10px] text-violet-600">字元總長</p>
                </div>
              </div>
              {promptPreview.brand_prompt && (
                <div className="bg-violet-50 rounded-xl p-3 border border-violet-200">
                  <p className="text-xs font-semibold text-violet-700 mb-1 flex items-center gap-1"><Brain className="w-3 h-3" />品牌專屬人設</p>
                  <p className="text-xs text-violet-800 whitespace-pre-wrap leading-relaxed">{promptPreview.brand_prompt}</p>
                </div>
              )}
              <div className="bg-stone-50 rounded-xl p-3 border border-stone-200">
                <p className="text-xs font-semibold text-stone-600 mb-1 flex items-center gap-1"><Database className="w-3 h-3" />完整提示詞（送入 OpenAI 的全文）</p>
                <pre className="text-[11px] text-stone-700 whitespace-pre-wrap leading-relaxed font-sans max-h-[300px] overflow-y-auto">{promptPreview.full_prompt_preview}</pre>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowPromptPreview(false)} className="text-xs">關閉</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
