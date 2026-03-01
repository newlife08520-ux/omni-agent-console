import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Eye, EyeOff, Save, Key, Shield, MessageSquare } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Setting } from "@shared/schema";

export default function SettingsPage() {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: settings = [], isLoading } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  useEffect(() => {
    if (settings.length > 0) {
      const values: Record<string, string> = {};
      settings.forEach((s) => {
        values[s.key] = s.value;
      });
      setFormValues(values);
    }
  }, [settings]);

  const handleSave = async (key: string) => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/settings", { key, value: formValues[key] || "" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "儲存成功", description: "設定已更新" });
    } catch {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleTestModeToggle = async (checked: boolean) => {
    setFormValues((prev) => ({ ...prev, test_mode: checked ? "true" : "false" }));
    try {
      await apiRequest("PUT", "/api/settings", { key: "test_mode", value: checked ? "true" : "false" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: checked ? "安全測試模式已開啟" : "安全測試模式已關閉",
        description: checked ? "系統將以模擬方式回覆訊息" : "系統將使用正式 API 回覆",
      });
    } catch {
      toast({ title: "設定失敗", variant: "destructive" });
    }
  };

  const toggleKeyVisibility = (key: string) => {
    setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(value.length - 8) + value.substring(value.length - 4);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">載入設定中...</p>
      </div>
    );
  }

  const settingsFields = [
    {
      key: "openai_api_key",
      label: "OpenAI API 金鑰",
      icon: Key,
      placeholder: "sk-...",
      description: "用於 AI 自動回覆功能",
    },
    {
      key: "line_channel_secret",
      label: "LINE 頻道密鑰",
      icon: Shield,
      placeholder: "輸入頻道密鑰",
      description: "LINE Developers 主控台中的 Channel Secret",
    },
    {
      key: "line_channel_access_token",
      label: "LINE 頻道存取權杖",
      icon: MessageSquare,
      placeholder: "輸入存取權杖",
      description: "LINE Developers 主控台中的長效存取權杖",
    },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-xl font-semibold" data-testid="text-settings-title">系統設定</h1>
        <p className="text-sm text-muted-foreground mt-1">管理 API 金鑰與系統環境設定</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-amber-500" />
                <span className="font-medium text-sm">安全測試模式</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                開啟後，系統將以模擬方式回覆訊息，不會呼叫真實的 OpenAI API
              </p>
            </div>
            <Switch
              data-testid="switch-test-mode"
              checked={formValues.test_mode === "true"}
              onCheckedChange={handleTestModeToggle}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {settingsFields.map((field) => (
          <Card key={field.key}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <field.icon className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">{field.label}</span>
              </div>
              <p className="text-xs text-muted-foreground">{field.description}</p>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    data-testid={`input-${field.key}`}
                    type={showKeys[field.key] ? "text" : "password"}
                    placeholder={field.placeholder}
                    value={
                      showKeys[field.key]
                        ? formValues[field.key] || ""
                        : formValues[field.key]
                        ? maskValue(formValues[field.key])
                        : ""
                    }
                    onChange={(e) => {
                      if (showKeys[field.key]) {
                        setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }));
                      }
                    }}
                    readOnly={!showKeys[field.key]}
                  />
                  <button
                    type="button"
                    onClick={() => toggleKeyVisibility(field.key)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    data-testid={`button-toggle-${field.key}`}
                  >
                    {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <Button
                  onClick={() => handleSave(field.key)}
                  disabled={saving}
                  data-testid={`button-save-${field.key}`}
                >
                  <Save className="w-4 h-4 mr-1" />
                  儲存
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
