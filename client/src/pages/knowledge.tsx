import { useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Brain,
  Upload,
  Trash2,
  FileText,
  Save,
  GripVertical,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Setting, KnowledgeFile } from "@shared/schema";

export default function KnowledgePage() {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  if (!promptLoaded && settings.length > 0) {
    const prompt = settings.find((s) => s.key === "system_prompt");
    if (prompt) {
      setSystemPrompt(prompt.value);
      setPromptLoaded(true);
    }
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
      toast({ title: "儲存成功", description: "System Prompt 已更新" });
    } catch {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleUploadFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".txt")) {
        toast({ title: "檔案格式錯誤", description: "僅支援 .txt 檔案", variant: "destructive" });
        return;
      }
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/knowledge-files", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!res.ok) throw new Error("Upload failed");
        queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
        toast({ title: "上傳成功", description: `${file.name} 已上傳` });
      } catch {
        toast({ title: "上傳失敗", variant: "destructive" });
      } finally {
        setUploading(false);
      }
    },
    [queryClient, toast]
  );

  const handleDeleteFile = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/knowledge-files/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "刪除成功" });
    } catch {
      toast({ title: "刪除失敗", variant: "destructive" });
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) handleUploadFile(droppedFile);
    },
    [handleUploadFile]
  );

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="knowledge-page">
      <div>
        <h1 className="text-xl font-semibold" data-testid="text-knowledge-title">AI 與知識庫</h1>
        <p className="text-sm text-muted-foreground mt-1">管理 AI 行為指令與知識庫文件</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">系統指令 (System Prompt)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            定義 AI 客服助理的行為、語氣與回覆規則
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            data-testid="textarea-system-prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="輸入系統指令..."
            className="min-h-[160px] resize-y text-sm"
          />
          <div className="flex justify-end">
            <Button onClick={handleSavePrompt} disabled={saving} data-testid="button-save-prompt">
              <Save className="w-4 h-4 mr-1" />
              {saving ? "儲存中..." : "儲存指令"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">知識庫文件</span>
          </div>
          <p className="text-xs text-muted-foreground">
            上傳 .txt 文件作為 AI 回覆的參考知識
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
              dragOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/20"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            data-testid="dropzone-upload"
          >
            <Upload className="w-8 h-8 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              {uploading ? "上傳中..." : "拖曳檔案至此或點擊上傳"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">僅支援 .txt 格式</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUploadFile(f);
                e.target.value = "";
              }}
              data-testid="input-file-upload"
            />
          </div>

          {filesLoading ? (
            <p className="text-sm text-muted-foreground text-center py-4">載入檔案列表...</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">尚未上傳任何文件</p>
          ) : (
            <div className="space-y-2">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-3 p-3 rounded-md bg-muted/50"
                  data-testid={`file-item-${file.id}`}
                >
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.original_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDeleteFile(file.id)}
                    data-testid={`button-delete-file-${file.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
