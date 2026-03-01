import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Eye, EyeOff, Save, Key, Shield, MessageSquare, Plug, Loader2, Palette, Type, Image, MessageCircle, Zap, AlertTriangle, ShoppingBag } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Setting } from "@shared/schema";

interface SettingsPageProps {
  userRole?: string;
}

export default function SettingsPage({ userRole }: SettingsPageProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState("");
  const [testing, setTesting] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: authData } = useQuery<{ authenticated: boolean; user?: { role: string } }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const currentRole = authData?.user?.role || userRole || "cs_agent";
  const isSuperAdmin = currentRole === "super_admin";

  const { data: settings = [], isLoading } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
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
      toast({ title: "儲存成功", description: "設定已更新" });
    } catch { toast({ title: "儲存失敗", variant: "destructive" }); }
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
    } catch { toast({ title: "儲存失敗", variant: "destructive" }); }
    finally { setSaving(""); }
  };

  const handleTestConnection = async (type: string) => {
    setTesting(type);
    try {
      await apiRequest("POST", "/api/settings/test-connection", { type });
      toast({ title: "連線成功", description: `${type} 連線測試通過` });
    } catch { toast({ title: "連線失敗", variant: "destructive" }); }
    finally { setTesting(""); }
  };

  const handleTestModeToggle = async (checked: boolean) => {
    setFormValues((prev) => ({ ...prev, test_mode: checked ? "true" : "false" }));
    try {
      await apiRequest("PUT", "/api/settings", { key: "test_mode", value: checked ? "true" : "false" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: checked ? "安全測試模式已開啟" : "安全測試模式已關閉" });
    } catch { toast({ title: "設定失敗", variant: "destructive" }); }
  };

  const toggleKeyVisibility = (key: string) => setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
  };

  const quickButtons = (formValues.quick_buttons || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入設定中...</p></div>;
  }

  const apiKeyFields = [
    { key: "openai_api_key", label: "OpenAI API 金鑰", icon: Key, placeholder: "sk-...", description: "用於 AI 自動回覆功能", testLabel: "OpenAI" },
    { key: "line_channel_secret", label: "LINE 頻道密鑰", icon: Shield, placeholder: "輸入頻道密鑰", description: "LINE Developers 主控台中的 Channel Secret", testLabel: "LINE Secret" },
    { key: "line_channel_access_token", label: "LINE 頻道存取權杖", icon: MessageSquare, placeholder: "輸入存取權杖", description: "LINE Developers 主控台中的長效存取權杖", testLabel: "LINE Token" },
  ];

  const superLandingFields = [
    { key: "superlanding_merchant_no", label: "一頁商店 Merchant No", icon: ShoppingBag, placeholder: "輸入商店編號", description: "一頁商店 (Super Landing) 的 merchant_no", testLabel: "一頁商店" },
    { key: "superlanding_access_key", label: "一頁商店 Access Key", icon: Key, placeholder: "輸入存取金鑰", description: "一頁商店 (Super Landing) 的 access_key", testLabel: "一頁商店 Key" },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-settings-title">系統設定</h1>
        <p className="text-sm text-stone-500 mt-1">
          {isSuperAdmin ? "管理 API 金鑰、品牌外觀、LINE 迎賓與轉人工設定" : "管理品牌外觀、LINE 迎賓與轉人工設定"}
        </p>
      </div>

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
        <>
          <div className="space-y-4">
            {apiKeyFields.map((field) => (
              <div key={field.key} className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center"><field.icon className="w-4 h-4 text-stone-500" /></div>
                  <div>
                    <span className="text-sm font-semibold text-stone-800">{field.label}</span>
                    <p className="text-xs text-stone-500">{field.description}</p>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <div className="relative flex-1">
                    <Input data-testid={`input-${field.key}`} type={showKeys[field.key] ? "text" : "password"} placeholder={field.placeholder}
                      value={showKeys[field.key] ? (formValues[field.key] || "") : (formValues[field.key] ? maskValue(formValues[field.key]) : "")}
                      onChange={(e) => { if (showKeys[field.key]) setFormValues((prev) => ({ ...prev, [field.key]: e.target.value })); }}
                      readOnly={!showKeys[field.key]} className="pr-10 bg-stone-50 border-stone-200" />
                    <button type="button" onClick={() => toggleKeyVisibility(field.key)} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600" data-testid={`button-toggle-${field.key}`}>
                      {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button variant="secondary" onClick={() => handleTestConnection(field.testLabel)} disabled={testing === field.testLabel} data-testid={`button-test-${field.key}`} className="text-xs shrink-0 bg-stone-100 hover:bg-stone-200">
                    {testing === field.testLabel ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試連線</>}
                  </Button>
                  <Button onClick={() => handleSave(field.key)} disabled={saving === field.key} data-testid={`button-save-${field.key}`} className="text-xs shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Save className="w-3.5 h-3.5 mr-1" />{saving === field.key ? "儲存中" : "儲存"}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-superlanding">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center"><ShoppingBag className="w-4 h-4 text-orange-600" /></div>
              <div>
                <span className="text-sm font-semibold text-stone-800">一頁商店 (Super Landing) API 串接</span>
                <p className="text-xs text-stone-500">串接一頁商店訂單系統，讓 AI 與客服人員可查詢客戶訂單狀態</p>
              </div>
            </div>
            <div className="space-y-3">
              {superLandingFields.map((field) => (
                <div key={field.key}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <field.icon className="w-3.5 h-3.5 text-stone-400" />
                    <label className="text-xs font-medium text-stone-600">{field.label}</label>
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input data-testid={`input-${field.key}`} type={showKeys[field.key] ? "text" : "password"} placeholder={field.placeholder}
                        value={showKeys[field.key] ? (formValues[field.key] || "") : (formValues[field.key] ? maskValue(formValues[field.key]) : "")}
                        onChange={(e) => { if (showKeys[field.key]) setFormValues((prev) => ({ ...prev, [field.key]: e.target.value })); }}
                        readOnly={!showKeys[field.key]} className="pr-10 bg-stone-50 border-stone-200" />
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
            </div>
          </div>
        </>
      )}
    </div>
  );
}
