import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Save } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function AssignmentRulesForm() {
  const { data: rules, isLoading } = useQuery<{ human_first_reply_sla_minutes: number; assignment_auto_enabled: boolean; assignment_timeout_reassign_enabled: boolean }>({
    queryKey: ["/api/settings/assignment-rules"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const [form, setForm] = useState({ human_first_reply_sla_minutes: 10, assignment_auto_enabled: true, assignment_timeout_reassign_enabled: true });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    if (rules) setForm({ human_first_reply_sla_minutes: rules.human_first_reply_sla_minutes, assignment_auto_enabled: rules.assignment_auto_enabled, assignment_timeout_reassign_enabled: rules.assignment_timeout_reassign_enabled });
  }, [rules]);
  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/settings/assignment-rules", form);
      toast({ title: "已儲存分配規則" });
    } catch (_e) {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  if (isLoading) return <div className="text-xs text-stone-400">載入中...</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <label className="text-xs font-medium text-stone-600">首次回覆 SLA（分鐘）</label>
        <Input type="number" min={1} max={120} value={form.human_first_reply_sla_minutes} onChange={(e) => setForm((p) => ({ ...p, human_first_reply_sla_minutes: Math.min(120, Math.max(1, parseInt(e.target.value, 10) || 10)) }))} className="w-20 h-8 text-xs bg-stone-50 border-stone-200" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-medium text-stone-600">啟用自動分配</span>
        <Switch checked={form.assignment_auto_enabled} onCheckedChange={(v) => setForm((p) => ({ ...p, assignment_auto_enabled: v }))} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-medium text-stone-600">逾時未回覆自動重分配</span>
        <Switch checked={form.assignment_timeout_reassign_enabled} onCheckedChange={(v) => setForm((p) => ({ ...p, assignment_timeout_reassign_enabled: v }))} />
      </div>
      <div className="flex justify-end pt-2">
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs">
          <Save className="w-3.5 h-3.5 mr-1" />{saving ? "儲存中..." : "儲存規則"}
        </Button>
      </div>
    </div>
  );
}
