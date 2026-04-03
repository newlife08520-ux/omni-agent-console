import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Eye, EyeOff, Save, Key, Shield, MessageSquare, Plug, Loader2, Palette, Type, Image, Sparkles,
  MessageCircle, Zap, AlertTriangle, ShoppingBag, Building2, Plus, Pencil, Trash2,
  Hash, CheckCircle, XCircle, ExternalLink, RefreshCw, Wifi, WifiOff, CircleDot, Users, Tag, ChevronUp, ChevronDown,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge, type HealthStatus, type HealthEntry } from "@/components/brand-channel-manager";
import type { Setting } from "@shared/schema";

interface SettingsPageProps {
  userRole?: string;
}

const OPENAI_MODEL_QUICK_PICKS = ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"] as const;
const OPENAI_DEFAULT_MODEL_FALLBACK = "gpt-4o-mini";

type OpenAIModelsPayload = {
  defaultMainModel: string;
  main: { effective: string; source: string; envVarSet: boolean; storedInDb: string };
  router: { effective: string; source: string; envVarSet: boolean; storedInDb: string };
};

function mainModelSourceLabel(source: string): string {
  if (source === "env") return "環境變數 OPENAI_MODEL（優先）";
  if (source === "database") return "資料庫設定";
  return "系統預設";
}

function routerModelSourceLabel(source: string): string {
  if (source === "env") return "環境變數 OPENAI_ROUTER_MODEL（優先）";
  if (source === "database") return "資料庫設定";
  if (source === "inherits_main") return "與主模型相同";
  return source;
}

function TagShortcutsManager() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: list = [], isLoading } = useQuery<{ name: string; order: number }[]>({
    queryKey: ["/api/settings/tag-shortcuts"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const [newName, setNewName] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const saveList = async (tags: { name: string; order: number }[]) => {
    try {
      await apiRequest("PUT", "/api/settings/tag-shortcuts", { tags });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/tag-shortcuts"] });
      toast({ title: "已儲存標籤設定" });
    } catch (_e) {
      toast({ title: "儲存失敗", variant: "destructive" });
    }
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    const next = [...list, { name, order: list.length }];
    saveList(next);
    setNewName("");
  };

  const handleDelete = (index: number) => {
    const next = list.filter((_, i) => i !== index).map((t, i) => ({ ...t, order: i }));
    saveList(next);
    setEditingIndex(null);
  };

  const handleRename = (index: number, newVal: string) => {
    if (editingIndex !== index) return;
    const val = newVal.trim();
    if (!val) { setEditingIndex(null); return; }
    const next = list.map((t, i) => (i === index ? { ...t, name: val } : t));
    saveList(next);
    setEditingIndex(null);
  };

  const handleMove = (index: number, dir: number) => {
    const to = index + dir;
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    saveList(next.map((t, i) => ({ ...t, order: i })));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-xl bg-sky-100 flex items-center justify-center"><Tag className="w-4 h-4 text-sky-600" /></div>
        <div>
          <span className="text-sm font-semibold text-stone-800">快速選取常駐標籤</span>
          <p className="text-xs text-stone-500">管理對話頁「快速選取」區的標籤，可新增、刪除、改名、排序，重整後仍存在</p>
        </div>
      </div>
      {isLoading ? (
        <p className="text-xs text-stone-400">載入中...</p>
      ) : (
        <>
          <div className="flex gap-2">
            <Input placeholder="新增標籤名稱" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} className="bg-stone-50 border-stone-200 text-sm max-w-[180px]" data-testid="input-new-tag-shortcut" />
            <Button size="sm" onClick={handleAdd} disabled={!newName.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-tag-shortcut"><Plus className="w-3.5 h-3.5 mr-1" />新增</Button>
          </div>
          <ul className="space-y-1.5">
            {list.map((t, i) => (
              <li key={`${t.name}-${i}`} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-stone-50 border border-stone-100">
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => handleMove(i, -1)} disabled={i === 0} data-testid={`button-tag-up-${i}`}><ChevronUp className="w-3 h-3" /></Button>
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => handleMove(i, 1)} disabled={i === list.length - 1} data-testid={`button-tag-down-${i}`}><ChevronDown className="w-3 h-3" /></Button>
                </div>
                {editingIndex === i ? (
                  <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} onBlur={() => handleRename(i, editValue)} onKeyDown={(e) => { if (e.key === "Enter") handleRename(i, editValue); if (e.key === "Escape") setEditingIndex(null); }} className="h-7 text-xs flex-1" autoFocus data-testid={`input-rename-tag-${i}`} />
                ) : (
                  <span className="text-sm text-stone-800 flex-1 truncate" onDoubleClick={() => { setEditingIndex(i); setEditValue(t.name); }} data-testid={`text-tag-name-${i}`}>{t.name}</span>
                )}
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-stone-400 hover:text-red-600" onClick={() => handleDelete(i)} data-testid={`button-delete-tag-${i}`}><Trash2 className="w-3.5 h-3.5" /></Button>
              </li>
            ))}
          </ul>
          {list.length === 0 && <p className="text-xs text-stone-400">尚無標籤，請新增後儲存。此列表會顯示在對話頁的「快速選取」區。</p>}
        </>
      )}
    </div>
  );
}

export default function SettingsPage({ userRole }: SettingsPageProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState("");
  const [testing, setTesting] = useState("");
  const [apiHealth, setApiHealth] = useState<Record<string, HealthEntry>>({});
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: authData } = useQuery<{ authenticated: boolean; user?: { role: string } }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const currentRole = authData?.user?.role || userRole || "cs_agent";
  const isSuperAdmin = currentRole === "super_admin";
  /** 與 /settings 路由一致：行銷主管也需設定模型，但 API 金鑰仍僅超級管理員 */
  const canConfigureOpenaiModels = isSuperAdmin || currentRole === "marketing_manager";

  const { data: settings = [], isLoading } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const {
    data: openaiModels,
    isLoading: openaiModelsLoading,
    isError: openaiModelsIsError,
    error: openaiModelsQueryError,
  } = useQuery<OpenAIModelsPayload>({
    queryKey: ["/api/settings/openai-models"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: canConfigureOpenaiModels,
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (settings.length > 0) {
      const values: Record<string, string> = {};
      settings.forEach((s) => { values[s.key] = s.value; });
      setFormValues(values);
    }
  }, [settings]);

  const handleSave = async (key: string) => {
    setSaving(key);
    try {
      await apiRequest("PUT", "/api/settings", { key, value: formValues[key] || "" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      if (key === "openai_model" || key === "openai_router_model") {
        queryClient.invalidateQueries({ queryKey: ["/api/settings/openai-models"] });
      }
      toast({ title: "儲存成功", description: "設定已更新" });
    } catch (_e) { toast({ title: "儲存失敗", variant: "destructive" }); }
    finally { setSaving(""); }
  };

  const handleSaveMultiple = async (keys: string[]) => {
    const firstKey = keys[0];
    setSaving(firstKey);
    try {
      for (const key of keys) {
        await apiRequest("PUT", "/api/settings", { key, value: formValues[key] || "" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "儲存成功", description: "所有設定已更新" });
    } catch (_e) { toast({ title: "儲存失敗", variant: "destructive" }); }
    finally { setSaving(""); }
  };

  const handleTestModeToggle = async (checked: boolean) => {
    setFormValues((prev) => ({ ...prev, test_mode: checked ? "true" : "false" }));
    try {
      await apiRequest("PUT", "/api/settings", { key: "test_mode", value: checked ? "true" : "false" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: checked ? "安全測試模式已開啟" : "安全測試模式已關閉" });
    } catch (_e) { toast({ title: "設定失敗", variant: "destructive" }); }
  };

  const toggleKeyVisibility = (key: string) => setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
  };

  const quickButtons = (formValues.quick_buttons || "").split(",").map((s) => s.trim()).filter(Boolean);

  const updateApiHealth = (key: string, entry: HealthEntry) => {
    setApiHealth(prev => ({ ...prev, [key]: entry }));
  };

  const handleTestConnectionWithStatus = async (type: string) => {
    setTesting(type);
    updateApiHealth(type, { status: "loading", message: "檢測中..." });
    try {
      const res = await fetch("/api/settings/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        toast({ title: "連線成功", description: data.message });
        updateApiHealth(type, { status: "ok", message: data.message });
      } else {
        toast({ title: "連線失敗", description: data.message, variant: "destructive" });
        updateApiHealth(type, { status: "error", message: data.message });
      }
    } catch (_e) {
      toast({ title: "連線失敗", description: "無法連線至伺服器", variant: "destructive" });
      updateApiHealth(type, { status: "error", message: "無法連線至伺服器" });
    }
    finally { setTesting(""); }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入設定中...</p></div>;
  }

  const apiKeyFields = [
    {
      key: "openai_api_key",
      label: "OpenAI API 金鑰",
      icon: Key,
      placeholder: "sk-...",
      description: "金鑰用於呼叫 OpenAI。請先看本區塊上方「生效中」模型是否正確，再按測試連線驗證。",
      testType: "openai",
    },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-settings-title">系統設定</h1>
        <p className="text-sm text-stone-500 mt-1">
          {isSuperAdmin ? "API 金鑰、安全與各項系統全域設定。品牌與渠道請至左側選單「品牌與渠道」；排班與派案請至「團隊管理」。" : "管理品牌外觀、LINE 迎賓與轉人工設定"}
        </p>
      </div>

      {canConfigureOpenaiModels && (
        <div
          className="rounded-xl border-2 border-indigo-400/90 bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-4 shadow-md ring-1 ring-indigo-100"
          data-testid="banner-openai-models-hero"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wide text-indigo-900">OpenAI / ChatGPT · 目前生效模型</p>
              {openaiModels ? (
                <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-stone-900">
                  <span className="text-sm">
                    主模型{" "}
                    <code className="rounded-md border border-indigo-200 bg-white px-2 py-1 font-mono text-base font-semibold text-indigo-950 shadow-sm">
                      {openaiModels.main.effective}
                    </code>
                  </span>
                  <span className="hidden text-stone-300 sm:inline">|</span>
                  <span className="text-sm">
                    Router{" "}
                    <code className="rounded-md border border-indigo-200 bg-white px-2 py-1 font-mono text-base font-semibold text-indigo-950 shadow-sm">
                      {openaiModels.router.effective}
                    </code>
                  </span>
                </div>
              ) : openaiModelsLoading ? (
                <p className="mt-2 flex items-center gap-2 text-sm text-stone-600">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  正在向伺服器查詢生效模型…
                </p>
              ) : (
                <div className="mt-2 text-sm text-amber-900">
                  <p>尚未取得生效模型。請按右側「重新整理」，或確認已登入（超級管理員／行銷主管）。</p>
                  {openaiModelsIsError && openaiModelsQueryError != null ? (
                    <p className="mt-1 break-all font-mono text-xs text-red-700">
                      {(openaiModelsQueryError as Error).message}
                    </p>
                  ) : null}
                </div>
              )}
              <p className="mt-2 text-[11px] text-stone-600">
                紫色邊框「OpenAI / ChatGPT」卡片在安全測試模式正下方，可編輯模型；API 金鑰僅超級管理員可見。
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0 border-indigo-200 bg-white hover:bg-indigo-50"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/settings/openai-models"] })}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              重新整理模型狀態
            </Button>
          </div>
        </div>
      )}

      {isSuperAdmin && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center"><Shield className="w-4 h-4 text-amber-600" /></div>
                <span className="font-semibold text-sm text-stone-800">安全測試模式</span>
              </div>
              <p className="text-xs text-stone-500 mt-1.5 ml-10">開啟後，系統將以模擬方式回覆訊息，不會呼叫真實 API</p>
            </div>
            <Switch data-testid="switch-test-mode" checked={formValues.test_mode === "true"} onCheckedChange={handleTestModeToggle} />
          </div>
        </div>
      )}

      {canConfigureOpenaiModels && (
        <div className="space-y-4">
            {apiKeyFields.map((field) =>
              field.key === "openai_api_key" ? (
                <div
                  key={field.key}
                  className="bg-white rounded-2xl border-2 border-indigo-200/90 p-5 shadow-md ring-1 ring-indigo-100"
                  data-testid="section-openai-full"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center">
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                      </div>
                      <div>
                        <span className="text-sm font-semibold text-stone-800">OpenAI / ChatGPT</span>
                        <p className="text-xs text-stone-500">
                          頁首橫幅會顯示生效模型；此卡片可編輯模型 ID
                          {isSuperAdmin ? " 與 API 金鑰（下方）。" : "（API 金鑰與測試連線僅超級管理員）。"}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs shrink-0"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/settings/openai-models"] })}
                      data-testid="button-refresh-openai-models"
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1" />
                      重新整理狀態
                    </Button>
                  </div>

                  {openaiModelsIsError && (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                      無法載入生效模型：
                      <span className="ml-1 break-all font-mono">{(openaiModelsQueryError as Error)?.message}</span>
                    </div>
                  )}
                  {openaiModelsLoading && (
                    <p className="mb-3 flex items-center gap-2 text-xs text-stone-500">
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                      載入模型狀態中…
                    </p>
                  )}
                  {openaiModels && (
                    <>
                      {(openaiModels.main.envVarSet || openaiModels.router.envVarSet) && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <div className="text-xs text-amber-900 space-y-1">
                            {openaiModels.main.envVarSet && (
                              <p>
                                伺服器已設定 <span className="font-mono">OPENAI_MODEL</span>，會<strong>覆寫</strong>「主對話模型」的資料庫值。
                              </p>
                            )}
                            {openaiModels.router.envVarSet && (
                              <p>
                                伺服器已設定 <span className="font-mono">OPENAI_ROUTER_MODEL</span>，會<strong>覆寫</strong>「Router 模型」的資料庫值。
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="grid gap-3 sm:grid-cols-2 mb-4">
                        <div className="rounded-xl border border-stone-100 bg-stone-50/80 p-3">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-stone-500 mb-1">主對話模型（生效中）</p>
                          <p className="font-mono text-sm font-semibold text-stone-900 break-all" data-testid="text-effective-main-model">
                            {openaiModels.main.effective}
                          </p>
                          <p className="text-xs text-stone-500 mt-1">{mainModelSourceLabel(openaiModels.main.source)}</p>
                          <p className="text-[10px] text-stone-400 mt-1">
                            未設定時預設：<span className="font-mono">{openaiModels.defaultMainModel}</span>
                          </p>
                        </div>
                        <div className="rounded-xl border border-stone-100 bg-stone-50/80 p-3">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-stone-500 mb-1">Hybrid Router 模型（生效中）</p>
                          <p className="font-mono text-sm font-semibold text-stone-900 break-all" data-testid="text-effective-router-model">
                            {openaiModels.router.effective}
                          </p>
                          <p className="text-xs text-stone-500 mt-1">{routerModelSourceLabel(openaiModels.router.source)}</p>
                        </div>
                      </div>
                    </>
                  )}
                  {!openaiModels && !openaiModelsLoading && !openaiModelsIsError && (
                    <p className="mb-3 text-xs text-stone-500">尚未取得模型資料，請按右上角「重新整理狀態」。</p>
                  )}

                  <div className="space-y-4 mb-6">
                        <div>
                          <label className="text-xs font-medium text-stone-600 mb-1.5 block">
                            主對話模型 ID（<span className="font-mono">openai_model</span>，可自填任意官方模型字串）
                          </label>
                          <p className="text-[11px] text-stone-400 mb-2">
                            留空則使用預設{" "}
                            <span className="font-mono">{openaiModels?.defaultMainModel ?? OPENAI_DEFAULT_MODEL_FALLBACK}</span>
                            （若伺服器未設環境變數）。
                          </p>
                          <Input
                            data-testid="input-openai-model"
                            placeholder={openaiModels?.defaultMainModel ?? OPENAI_DEFAULT_MODEL_FALLBACK}
                            value={formValues.openai_model ?? ""}
                            onChange={(e) => setFormValues((prev) => ({ ...prev, openai_model: e.target.value }))}
                            className="font-mono text-sm bg-stone-50 border-stone-200"
                          />
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {OPENAI_MODEL_QUICK_PICKS.map((id) => (
                              <Button
                                key={id}
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="text-[10px] h-7 px-2 font-mono bg-stone-100"
                                onClick={() => setFormValues((prev) => ({ ...prev, openai_model: id }))}
                              >
                                {id}
                              </Button>
                            ))}
                          </div>
                          <div className="flex justify-end mt-2">
                            <Button
                              onClick={() => handleSave("openai_model")}
                              disabled={saving === "openai_model"}
                              data-testid="button-save-openai-model"
                              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                            >
                              <Save className="w-3.5 h-3.5 mr-1" />
                              {saving === "openai_model" ? "儲存中" : "儲存主模型"}
                            </Button>
                          </div>
                        </div>

                        <div>
                          <label className="text-xs font-medium text-stone-600 mb-1.5 block">
                            Router 模型 ID（<span className="font-mono">openai_router_model</span>）
                          </label>
                          <p className="text-[11px] text-stone-400 mb-2">
                            Hybrid 意圖路由專用；<strong>留空</strong>則與主模型相同（若無 <span className="font-mono">OPENAI_ROUTER_MODEL</span>）。
                          </p>
                          <Input
                            data-testid="input-openai-router-model"
                            placeholder="留空＝沿用主模型"
                            value={formValues.openai_router_model ?? ""}
                            onChange={(e) => setFormValues((prev) => ({ ...prev, openai_router_model: e.target.value }))}
                            className="font-mono text-sm bg-stone-50 border-stone-200"
                          />
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {OPENAI_MODEL_QUICK_PICKS.map((id: (typeof OPENAI_MODEL_QUICK_PICKS)[number]) => (
                              <Button
                                key={`r-${id}`}
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="text-[10px] h-7 px-2 font-mono bg-stone-100"
                                onClick={() => setFormValues((prev) => ({ ...prev, openai_router_model: id }))}
                              >
                                {id}
                              </Button>
                            ))}
                          </div>
                          <div className="flex justify-end mt-2">
                            <Button
                              onClick={() => handleSave("openai_router_model")}
                              disabled={saving === "openai_router_model"}
                              data-testid="button-save-openai-router-model"
                              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                            >
                              <Save className="w-3.5 h-3.5 mr-1" />
                              {saving === "openai_router_model" ? "儲存中" : "儲存 Router 模型"}
                            </Button>
                          </div>
                        </div>
                  </div>

                  {isSuperAdmin && (
                  <div className="border-t border-stone-200 pt-5">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center">
                        <field.icon className="w-4 h-4 text-stone-500" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-stone-800">{field.label}</span>
                          {field.testType && apiHealth[field.testType] && (
                            <StatusBadge status={apiHealth[field.testType].status as HealthStatus} message={apiHealth[field.testType].message} />
                          )}
                        </div>
                        <p className="text-xs text-stone-500">{field.description}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <div className="relative flex-1">
                        <Input
                          data-testid={`input-${field.key}`}
                          type={showKeys[field.key] ? "text" : "password"}
                          placeholder={field.placeholder}
                          value={formValues[field.key] || ""}
                          onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                          className="pr-10 bg-stone-50 border-stone-200"
                        />
                        <button
                          type="button"
                          onClick={() => toggleKeyVisibility(field.key)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                          data-testid={`button-toggle-${field.key}`}
                        >
                          {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {field.testType && (
                        <Button
                          variant="secondary"
                          onClick={() => handleTestConnectionWithStatus(field.testType!)}
                          disabled={testing === field.testType}
                          data-testid={`button-test-${field.key}`}
                          className="text-xs shrink-0 bg-stone-100 hover:bg-stone-200"
                        >
                          {testing === field.testType ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                              測試中
                            </>
                          ) : (
                            <>
                              <Plug className="w-3.5 h-3.5 mr-1" />
                              測試連線
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        onClick={() => handleSave(field.key)}
                        disabled={saving === field.key}
                        data-testid={`button-save-${field.key}`}
                        className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <Save className="w-3.5 h-3.5 mr-1" />
                        {saving === field.key ? "儲存中" : "儲存"}
                      </Button>
                    </div>
                  </div>
                  )}
                </div>
              ) : (
                <div key={field.key} className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center">
                      <field.icon className="w-4 h-4 text-stone-500" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-stone-800">{field.label}</span>
                        {field.testType && apiHealth[field.testType] && (
                          <StatusBadge status={apiHealth[field.testType].status as HealthStatus} message={apiHealth[field.testType].message} />
                        )}
                      </div>
                      <p className="text-xs text-stone-500">{field.description}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <div className="relative flex-1">
                      <Input
                        data-testid={`input-${field.key}`}
                        type={showKeys[field.key] ? "text" : "password"}
                        placeholder={field.placeholder}
                        value={formValues[field.key] || ""}
                        onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="pr-10 bg-stone-50 border-stone-200"
                      />
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(field.key)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                        data-testid={`button-toggle-${field.key}`}
                      >
                        {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    {field.testType && (
                      <Button
                        variant="secondary"
                        onClick={() => handleTestConnectionWithStatus(field.testType!)}
                        disabled={testing === field.testType}
                        data-testid={`button-test-${field.key}`}
                        className="text-xs shrink-0 bg-stone-100 hover:bg-stone-200"
                      >
                        {testing === field.testType ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                            測試中
                          </>
                        ) : (
                          <>
                            <Plug className="w-3.5 h-3.5 mr-1" />
                            測試連線
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      onClick={() => handleSave(field.key)}
                      disabled={saving === field.key}
                      data-testid={`button-save-${field.key}`}
                      className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <Save className="w-3.5 h-3.5 mr-1" />
                      {saving === field.key ? "儲存中" : "儲存"}
                    </Button>
                  </div>
                </div>
              )
            )}


      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center"><Palette className="w-4 h-4 text-violet-600" /></div>
          <div>
            <span className="text-sm font-semibold text-stone-800">品牌外觀設定</span>
            <p className="text-xs text-stone-500">自訂系統名稱與品牌 Logo，變更即時生效</p>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Type className="w-3.5 h-3.5 text-stone-400" />
              <label className="text-xs font-medium text-stone-600">系統名稱</label>
            </div>
            <div className="flex gap-2">
              <Input data-testid="input-system-name" placeholder="AI 客服中控台" value={formValues.system_name || ""} onChange={(e) => setFormValues((prev) => ({ ...prev, system_name: e.target.value }))} className="bg-stone-50 border-stone-200" />
              <Button onClick={() => handleSave("system_name")} disabled={saving === "system_name"} data-testid="button-save-system-name" className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                <Save className="w-3.5 h-3.5 mr-1" />{saving === "system_name" ? "儲存中" : "儲存"}
              </Button>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Image className="w-3.5 h-3.5 text-stone-400" />
              <label className="text-xs font-medium text-stone-600">Logo 圖片網址</label>
            </div>
            <div className="flex gap-2">
              <Input data-testid="input-logo-url" placeholder="https://example.com/logo.png" value={formValues.logo_url || ""} onChange={(e) => setFormValues((prev) => ({ ...prev, logo_url: e.target.value }))} className="bg-stone-50 border-stone-200" />
              <Button onClick={() => handleSave("logo_url")} disabled={saving === "logo_url"} data-testid="button-save-logo-url" className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                <Save className="w-3.5 h-3.5 mr-1" />{saving === "logo_url" ? "儲存中" : "儲存"}
              </Button>
            </div>
            {formValues.logo_url && (
              <div className="mt-2 flex items-center gap-2">
                <img src={formValues.logo_url} alt="Logo preview" className="w-8 h-8 rounded-lg object-cover border border-stone-200" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <span className="text-xs text-stone-400">預覽</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-welcome-settings">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><MessageCircle className="w-4 h-4 text-emerald-600" /></div>
          <div>
            <span className="text-sm font-semibold text-stone-800">LINE 迎賓與快捷按鈕設定</span>
            <p className="text-xs text-stone-500">設定新客戶首次進線時的歡迎詞與快速按鈕選項</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1.5 block">首次進線歡迎詞</label>
            <Textarea data-testid="input-welcome-message" placeholder="輸入歡迎詞..." value={formValues.welcome_message || ""} onChange={(e) => setFormValues((prev) => ({ ...prev, welcome_message: e.target.value }))} className="min-h-[80px] resize-y text-sm bg-stone-50 border-stone-200" />
          </div>
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1.5 block">快速按鈕 (Quick Replies)</label>
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                    <Zap className="w-3 h-3 text-emerald-600" />
                  </div>
                  <Input
                    data-testid={`input-quick-button-${i}`}
                    placeholder={`快速按鈕 ${i + 1}`}
                    value={quickButtons[i] || ""}
                    onChange={(e) => {
                      const newButtons = [...quickButtons];
                      while (newButtons.length <= i) newButtons.push("");
                      newButtons[i] = e.target.value;
                      setFormValues((prev) => ({ ...prev, quick_buttons: newButtons.filter(Boolean).join(",") }));
                    }}
                    className="bg-stone-50 border-stone-200 text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => handleSaveMultiple(["welcome_message", "quick_buttons"])} disabled={saving === "welcome_message"} data-testid="button-save-welcome" className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
              <Save className="w-3.5 h-3.5 mr-1" />{saving === "welcome_message" ? "儲存中..." : "儲存迎賓設定"}
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-human-transfer">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-xl bg-red-100 flex items-center justify-center"><AlertTriangle className="w-4 h-4 text-red-600" /></div>
          <div>
            <span className="text-sm font-semibold text-stone-800">智能轉人工觸發設定</span>
            <p className="text-xs text-stone-500">當客戶訊息包含這些字眼時，系統將自動停止 AI 回覆，並將該聯絡人標記為紅色「需人工處理」</p>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1.5 block">觸發關鍵字 (以逗號分隔)</label>
            <Input data-testid="input-human-keywords" placeholder="真人, 客服, 投訴, 生氣, 退貨, 爛" value={formValues.human_transfer_keywords || ""} onChange={(e) => setFormValues((prev) => ({ ...prev, human_transfer_keywords: e.target.value }))} className="bg-stone-50 border-stone-200" />
          </div>
          {formValues.human_transfer_keywords && (
            <div className="flex flex-wrap gap-1.5">
              {formValues.human_transfer_keywords.split(",").map((kw) => kw.trim()).filter(Boolean).map((kw, i) => (
                <span key={i} className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">{kw}</span>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={() => handleSave("human_transfer_keywords")} disabled={saving === "human_transfer_keywords"} data-testid="button-save-human-keywords" className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
              <Save className="w-3.5 h-3.5 mr-1" />{saving === "human_transfer_keywords" ? "儲存中..." : "儲存關鍵字"}
            </Button>
          </div>
        </div>
      </div>

      {isSuperAdmin && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-tag-shortcuts">
          <TagShortcutsManager />
        </div>
      )}

        </div>
      )}

      {isSuperAdmin && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-superlanding">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center"><ShoppingBag className="w-4 h-4 text-orange-600" /></div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-stone-800">一頁商店 (Super Landing) API 串接</span>
                  {apiHealth.superlanding && <StatusBadge status={apiHealth.superlanding.status as HealthStatus} message={apiHealth.superlanding.message} />}
                </div>
                <p className="text-xs text-stone-500">串接一頁商店訂單系統，讓 AI 與客服人員可查詢客戶訂單狀態</p>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 leading-relaxed">
                一頁商店的全域設定僅作為預設值。如需為不同品牌配置獨立的商店帳號，請在上方品牌管理中編輯各品牌的 Merchant No 和 Access Key。
              </p>
            </div>
            <div className="space-y-3">
              {[
                { key: "superlanding_merchant_no", label: "預設 Merchant No", icon: ShoppingBag, placeholder: "輸入商店編號" },
                { key: "superlanding_access_key", label: "預設 Access Key", icon: Key, placeholder: "輸入存取金鑰" },
              ].map((field) => (
                <div key={field.key}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <field.icon className="w-3.5 h-3.5 text-stone-400" />
                    <label className="text-xs font-medium text-stone-600">{field.label}</label>
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input data-testid={`input-${field.key}`} type={showKeys[field.key] ? "text" : "password"} placeholder={field.placeholder}
                        value={formValues[field.key] || ""}
                        onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        className="pr-10 bg-stone-50 border-stone-200" />
                      <button type="button" onClick={() => toggleKeyVisibility(field.key)} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                        {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <Button onClick={() => handleSave(field.key)} disabled={saving === field.key} data-testid={`button-save-${field.key}`} className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                      <Save className="w-3.5 h-3.5 mr-1" />{saving === field.key ? "儲存中" : "儲存"}
                    </Button>
                  </div>
                </div>
              ))}
              <div className="pt-2 flex justify-end">
                <Button variant="secondary" onClick={() => handleTestConnectionWithStatus("superlanding")} disabled={testing === "superlanding"} data-testid="button-test-superlanding" className="text-xs bg-stone-100 hover:bg-stone-200">
                  {testing === "superlanding" ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中...</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試一頁商店連線</>}
                </Button>
              </div>
            </div>
          </div>
      )}
    </div>
  );
}
