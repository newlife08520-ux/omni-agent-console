import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Eye, EyeOff, Save, Key, Shield, MessageSquare, Plug, Loader2 } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Setting } from "@shared/schema";

export default function SettingsPage() {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState("");
  const [testing, setTesting] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  const toggleKeyVisibility = (key: string) => {
    setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入設定中...</p></div>;
  }

  const settingsFields = [
    { key: "openai_api_key", label: "OpenAI API 金鑰", icon: Key, placeholder: "sk-...", description: "用於 AI 自動回覆功能", testLabel: "OpenAI" },
    { key: "line_channel_secret", label: "LINE 頻道密鑰", icon: Shield, placeholder: "輸入頻道密鑰", description: "LINE Developers 主控台中的 Channel Secret", testLabel: "LINE Secret" },
    { key: "line_channel_access_token", label: "LINE 頻道存取權杖", icon: MessageSquare, placeholder: "輸入存取權杖", description: "LINE Developers 主控台中的長效存取權杖", testLabel: "LINE Token" },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-settings-title">系統設定</h1>
        <p className="text-sm text-stone-500 mt-1">管理 API 金鑰與系統環境設定</p>
      </div>

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

      <div className="space-y-4">
        {settingsFields.map((field) => (
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
                <Input
                  data-testid={`input-${field.key}`}
                  type={showKeys[field.key] ? "text" : "password"}
                  placeholder={field.placeholder}
                  value={showKeys[field.key] ? (formValues[field.key] || "") : (formValues[field.key] ? maskValue(formValues[field.key]) : "")}
                  onChange={(e) => { if (showKeys[field.key]) setFormValues((prev) => ({ ...prev, [field.key]: e.target.value })); }}
                  readOnly={!showKeys[field.key]}
                  className="pr-10 bg-stone-50 border-stone-200"
                />
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
    </div>
  );
}
