import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function ScheduleForm() {
  const queryClient = useQueryClient();
  const { data: schedule, isLoading } = useQuery<{ work_start_time: string; work_end_time: string; lunch_start_time: string; lunch_end_time: string }>({
    queryKey: ["/api/settings/schedule"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const [form, setForm] = useState({ work_start_time: "09:00", work_end_time: "18:00", lunch_start_time: "12:30", lunch_end_time: "13:30" });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    if (schedule) setForm(schedule);
  }, [schedule]);
  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await apiRequest("PUT", "/api/settings/schedule", form) as { work_start_time: string; work_end_time: string; lunch_start_time: string; lunch_end_time: string };
      queryClient.setQueryData(["/api/settings/schedule"], updated);
      toast({ title: "已儲存客服時段" });
    } catch (_e) {
      toast({ title: "儲存失敗", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  if (isLoading) return <div className="text-xs text-stone-400">載入中...</div>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div>
        <label className="text-xs font-medium text-stone-600 block mb-1">上班開始</label>
        <Input type="time" value={form.work_start_time} onChange={(e) => setForm((p) => ({ ...p, work_start_time: e.target.value }))} className="bg-stone-50 border-stone-200" />
      </div>
      <div>
        <label className="text-xs font-medium text-stone-600 block mb-1">下班時間</label>
        <Input type="time" value={form.work_end_time} onChange={(e) => setForm((p) => ({ ...p, work_end_time: e.target.value }))} className="bg-stone-50 border-stone-200" />
      </div>
      <div>
        <label className="text-xs font-medium text-stone-600 block mb-1">午休開始</label>
        <Input type="time" value={form.lunch_start_time} onChange={(e) => setForm((p) => ({ ...p, lunch_start_time: e.target.value }))} className="bg-stone-50 border-stone-200" />
      </div>
      <div>
        <label className="text-xs font-medium text-stone-600 block mb-1">午休結束</label>
        <Input type="time" value={form.lunch_end_time} onChange={(e) => setForm((p) => ({ ...p, lunch_end_time: e.target.value }))} className="bg-stone-50 border-stone-200" />
      </div>
      <div className="col-span-2 sm:col-span-4 flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs">
          <Save className="w-3.5 h-3.5 mr-1" />{saving ? "儲存中..." : "儲存時段"}
        </Button>
      </div>
    </div>
  );
}
