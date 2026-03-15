import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Building2, Plus, Pencil, Trash2, Hash, CheckCircle, Plug, RefreshCw, Eye, EyeOff, Save, Loader2,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useToast } from "@/hooks/use-toast";
import type { Brand, Channel, ChannelPlatform } from "@shared/schema";

type AssignedAgent = { user_id: number; display_name: string; role: string };

function formatBrandAssignedSummary(agents: AssignedAgent[]): string {
  if (!agents.length) return "尚無負責人";
  const primary = agents.filter((a) => a.role === "primary").map((a) => a.display_name).join("、");
  const backup = agents.filter((a) => a.role === "backup").map((a) => a.display_name).join("、");
  const parts: string[] = [];
  if (primary) parts.push(`主責：${primary}`);
  if (backup) parts.push(`備援：${backup}`);
  return parts.join("；") || "尚無負責人";
}

export type HealthStatus = "ok" | "error" | "unconfigured" | "loading" | "unknown";

export interface HealthEntry {
  status: HealthStatus;
  message: string;
}

export function StatusDot({ status, size = "sm" }: { status: HealthStatus; size?: "sm" | "md" }) {
  const sizeClass = size === "md" ? "w-2.5 h-2.5" : "w-2 h-2";
  const colors: Record<HealthStatus, string> = {
    ok: "bg-emerald-500",
    error: "bg-red-500 animate-pulse",
    unconfigured: "bg-stone-300",
    loading: "bg-amber-400 animate-pulse",
    unknown: "bg-stone-300",
  };
  return <div className={`${sizeClass} rounded-full ${colors[status]} shrink-0`} />;
}

export function StatusBadge({ status, message }: { status: HealthStatus; message?: string }) {
  const config: Record<HealthStatus, { bg: string; text: string; label: string }> = {
    ok: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "連線正常" },
    error: { bg: "bg-red-50 border-red-200", text: "text-red-700", label: "連線異常" },
    unconfigured: { bg: "bg-stone-50 border-stone-200", text: "text-stone-500", label: "尚未設定" },
    loading: { bg: "bg-amber-50 border-amber-200", text: "text-amber-700", label: "檢測中..." },
    unknown: { bg: "bg-stone-50 border-stone-200", text: "text-stone-400", label: "未檢測" },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${c.bg} ${c.text}`} title={message}>
      <StatusDot status={status} />
      {c.label}
    </span>
  );
}

export function BrandChannelManager({ isSuperAdmin, readOnly = false }: { isSuperAdmin: boolean; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { brands, selectedBrandId, setSelectedBrandId } = useBrand();

  const [showBrandDialog, setShowBrandDialog] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [brandForm, setBrandForm] = useState({
    name: "", slug: "", logo_url: "", description: "", system_prompt: "",
    superlanding_merchant_no: "", superlanding_access_key: "",
    return_form_url: "",
    shopline_store_domain: "", shopline_api_token: "",
  });
  const [brandSaving, setBrandSaving] = useState(false);

  const [showChannelDialog, setShowChannelDialog] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [channelForm, setChannelForm] = useState({ platform: "line" as ChannelPlatform, channel_name: "", bot_id: "", access_token: "", channel_secret: "", is_ai_enabled: 0 });
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelVerifying, setChannelVerifying] = useState(false);
  const [testingChannel, setTestingChannel] = useState<number | null>(null);
  const [subscribingFeedChannelId, setSubscribingFeedChannelId] = useState<number | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [healthStatus, setHealthStatus] = useState<Record<string, HealthEntry>>({});
  const [healthLoading, setHealthLoading] = useState(false);
  const [testingBrandSL, setTestingBrandSL] = useState<number | null>(null);
  const [testingBrandShopline, setTestingBrandShopline] = useState<number | null>(null);
  const [refreshingProfiles, setRefreshingProfiles] = useState(false);
  const [reassignChannelId, setReassignChannelId] = useState<number | "">("");
  const [reassignBrandId, setReassignBrandId] = useState<number | "">("");
  const [reassignLoading, setReassignLoading] = useState(false);

  const handleRefreshProfiles = async () => {
    setRefreshingProfiles(true);
    try {
      const res = await fetch("/api/admin/refresh-profiles", { method: "POST", credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const line = data.line ?? { total: 0, updated: 0, failed: 0 };
        const fb = data.facebook ?? { total: 0, updated: 0, failed: 0 };
        const parts: string[] = [];
        if (line.total > 0) parts.push(`LINE: ${line.updated}/${line.total} 已更新${line.failed > 0 ? `，${line.failed} 失敗` : ""}`);
        if (fb.total > 0) parts.push(`Facebook: ${fb.updated}/${fb.total} 已更新${fb.failed > 0 ? `，${fb.failed} 失敗` : ""}`);
        toast({ title: "頭貼與姓名同步完成", description: parts.length ? parts.join("；") : "尚無需同步的聯絡人" });
      } else {
        toast({ title: "更新失敗", variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "更新失敗", variant: "destructive" });
    } finally {
      setRefreshingProfiles(false);
    }
  };

  const fetchHealthStatus = async () => {
    setHealthLoading(true);
    try {
      const res = await fetch("/api/health/status", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setHealthStatus(data);
      }
    } catch (_e) {}
    finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    if (isSuperAdmin) fetchHealthStatus();
  }, [isSuperAdmin]);

  const handleTestBrandSL = async (brandId: number) => {
    setTestingBrandSL(brandId);
    try {
      const res = await fetch(`/api/brands/${brandId}/test-superlanding`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        toast({ title: "連線成功", description: data.message });
        setHealthStatus(prev => ({ ...prev, [`superlanding_brand_${brandId}`]: { status: "ok", message: data.message } }));
      } else {
        toast({ title: "連線失敗", description: data.message, variant: "destructive" });
        setHealthStatus(prev => ({ ...prev, [`superlanding_brand_${brandId}`]: { status: "error", message: data.message } }));
      }
    } catch (_e) {
      toast({ title: "測試失敗", variant: "destructive" });
    } finally {
      setTestingBrandSL(null);
    }
  };

  const handleTestBrandShopline = async (brandId: number) => {
    setTestingBrandShopline(brandId);
    try {
      const res = await fetch(`/api/brands/${brandId}/test-shopline`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        toast({ title: "連線成功", description: data.message });
        setHealthStatus(prev => ({ ...prev, [`shopline_brand_${brandId}`]: { status: "ok", message: data.message } }));
      } else {
        toast({ title: "連線失敗", description: data.message, variant: "destructive" });
        setHealthStatus(prev => ({ ...prev, [`shopline_brand_${brandId}`]: { status: "error", message: data.message } }));
      }
    } catch (_e) {
      toast({ title: "測試失敗", variant: "destructive" });
    } finally {
      setTestingBrandShopline(null);
    }
  };

  const { data: allChannels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/brands", selectedBrandId, "channels"],
    queryFn: async () => {
      if (!selectedBrandId) return [];
      const res = await fetch(`/api/brands/${selectedBrandId}/channels`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBrandId,
  });

  const { data: allChannelsWithBrand = [] } = useQuery<Channel[] & { brand_name?: string }[]>({
    queryKey: ["/api/channels"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !readOnly,
  });

  const assignedAgentsQueries = useQueries({
    queries: brands.map((b) => ({
      queryKey: ["/api/brands", b.id, "assigned-agents"] as const,
      queryFn: getQueryFn<AssignedAgent[]>({ on401: "throw" }),
      enabled: true,
    })),
  });
  const assignedAgentsByBrand = useMemo(() => {
    const map: Record<number, AssignedAgent[]> = {};
    brands.forEach((b, i) => {
      map[b.id] = Array.isArray(assignedAgentsQueries[i]?.data) ? assignedAgentsQueries[i].data! : [];
    });
    return map;
  }, [brands, assignedAgentsQueries]);

  const openAddBrand = () => {
    setEditingBrand(null);
    setBrandForm({
      name: "", slug: "", logo_url: "", description: "", system_prompt: "",
      superlanding_merchant_no: "", superlanding_access_key: "",
      return_form_url: "",
      shopline_store_domain: "", shopline_api_token: "",
    });
    setShowBrandDialog(true);
  };

  const openEditBrand = (brand: Brand) => {
    setEditingBrand(brand);
    setBrandForm({
      name: brand.name, slug: brand.slug, logo_url: brand.logo_url || "",
      description: brand.description || "", system_prompt: brand.system_prompt || "",
      superlanding_merchant_no: brand.superlanding_merchant_no || "",
      superlanding_access_key: brand.superlanding_access_key || "",
      return_form_url: brand.return_form_url || "",
      shopline_store_domain: brand.shopline_store_domain || "",
      shopline_api_token: brand.shopline_api_token || "",
    });
    setShowBrandDialog(true);
  };

  const handleSaveBrand = async () => {
    if (!brandForm.name.trim()) {
      toast({ title: "品牌名稱為必填", variant: "destructive" });
      return;
    }
    setBrandSaving(true);
    try {
      if (editingBrand) {
        const payload = { ...brandForm };
        // 編輯時：金鑰欄位留空表示「不變更」，不送出以免覆蓋既有設定
        if (payload.superlanding_access_key === "") delete (payload as Record<string, unknown>).superlanding_access_key;
        if (payload.shopline_api_token === "") delete (payload as Record<string, unknown>).shopline_api_token;
        await apiRequest("PUT", `/api/brands/${editingBrand.id}`, payload);
      } else {
        const slug = brandForm.slug || brandForm.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-\u4e00-\u9fff]/g, "");
        await apiRequest("POST", "/api/brands", { ...brandForm, slug });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      toast({ title: editingBrand ? "品牌已更新" : "品牌已建立" });
      setShowBrandDialog(false);
    } catch (e: unknown) {
      const msg = typeof e === "object" && e !== null && "message" in e && typeof (e as Error).message === "string"
        ? (e as Error).message
        : "";
      let title = "操作失敗";
      let description: string | undefined;
      const jsonMatch = msg.match(/^\d+:\s*(\{[\s\S]*\})$/);
      if (jsonMatch) {
        try {
          const body = JSON.parse(jsonMatch[1]) as { message?: string };
          if (body.message) title = body.message;
        } catch {
          if (msg) description = msg.slice(0, 120);
        }
      } else if (msg) {
        description = msg.startsWith("4") || msg.startsWith("5") ? msg.slice(0, 120) : undefined;
      }
      toast({ title, description, variant: "destructive" });
    } finally {
      setBrandSaving(false);
    }
  };

  const handleDeleteBrand = async (id: number) => {
    if (brands.length <= 1) {
      toast({ title: "無法刪除", description: "至少需保留一個品牌", variant: "destructive" });
      return;
    }
    try {
      await apiRequest("DELETE", `/api/brands/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      if (selectedBrandId === id) setSelectedBrandId(brands.find(b => b.id !== id)?.id || null);
      toast({ title: "品牌已刪除" });
    } catch (_e) {
      toast({ title: "刪除失敗", variant: "destructive" });
    }
  };

  const openAddChannel = () => {
    setEditingChannel(null);
    setChannelForm({ platform: "line", channel_name: "", bot_id: "", access_token: "", channel_secret: "", is_ai_enabled: 0 });
    setShowChannelDialog(true);
  };

  const openEditChannel = (ch: Channel) => {
    setEditingChannel(ch);
    setChannelForm({ platform: ch.platform as ChannelPlatform, channel_name: ch.channel_name, bot_id: ch.bot_id, access_token: ch.access_token, channel_secret: ch.channel_secret, is_ai_enabled: ch.is_ai_enabled ?? 0 });
    setShowChannelDialog(true);
  };

  const handleSaveChannel = async () => {
    if (!channelForm.channel_name.trim()) {
      toast({ title: "渠道名稱為必填", variant: "destructive" });
      return;
    }
    setChannelSaving(true);
    try {
      let channelId: number | null = null;
      if (editingChannel) {
        await apiRequest("PUT", `/api/channels/${editingChannel.id}`, channelForm);
        channelId = editingChannel.id;
      } else {
        const res = await apiRequest("POST", `/api/brands/${selectedBrandId}/channels`, channelForm);
        const data = await res.json().catch(() => ({}));
        channelId = data?.channel?.id ?? null;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/brands", selectedBrandId, "channels"] });
      if (channelForm.platform === "line" && channelId != null) {
        const testRes = await fetch(`/api/channels/${channelId}/test`, { method: "POST", credentials: "include" });
        const testData = await testRes.json().catch(() => ({ success: false, message: "無法讀取驗證結果" }));
        if (testData.success) {
          toast({ title: editingChannel ? "渠道已更新" : "渠道已建立", description: "LINE 綁定成功，連線驗證通過。" });
        } else {
          toast({
            title: editingChannel ? "渠道已更新" : "渠道已建立",
            description: `LINE 連線驗證失敗：${testData.message || "請檢查 Token／Bot ID"}`,
            variant: "destructive",
          });
        }
      } else {
        toast({ title: editingChannel ? "渠道已更新" : "渠道已建立" });
      }
      setShowChannelDialog(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const jsonMatch = msg.match(/\d+:\s*(\{[\s\S]*\})/);
      let description: string | undefined;
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[1]) as { message?: string };
          description = obj.message;
        } catch {}
      }
      toast({ title: "操作失敗", description: description || msg.slice(0, 120), variant: "destructive" });
    } finally {
      setChannelSaving(false);
    }
  };

  const handleVerifyLineConnection = async () => {
    if (!channelForm.access_token?.trim()) {
      toast({ title: "請先填寫 Channel Access Token", variant: "destructive" });
      return;
    }
    setChannelVerifying(true);
    try {
      const res = await fetch("/api/channels/verify-line", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: channelForm.access_token.trim(), bot_id: channelForm.bot_id?.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        toast({ title: "驗證成功", description: data.message });
      } else {
        toast({ title: "驗證失敗", description: data.message || "請檢查 Token", variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "驗證失敗", variant: "destructive" });
    } finally {
      setChannelVerifying(false);
    }
  };

  const handleDeleteChannel = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/channels/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/brands", selectedBrandId, "channels"] });
      toast({ title: "渠道已刪除" });
    } catch (_e) {
      toast({ title: "刪除失敗", variant: "destructive" });
    }
  };

  const handleReassignByChannel = async () => {
    if (reassignChannelId === "" || reassignBrandId === "") {
      toast({ title: "請選擇渠道與目標品牌", variant: "destructive" });
      return;
    }
    setReassignLoading(true);
    try {
      const res = await fetch("/api/admin/contacts/reassign-by-channel", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: reassignChannelId, brand_id: reassignBrandId }),
      });
      const data = await res.json();
      if (data.success) {
        toast({ title: data.message || "已更新歸屬", description: `共 ${data.updated} 位聯絡人` });
        queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
        setReassignChannelId("");
        setReassignBrandId("");
      } else {
        toast({ title: data.message || "執行失敗", variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "執行失敗", variant: "destructive" });
    } finally {
      setReassignLoading(false);
    }
  };

  const handleTestChannel = async (id: number) => {
    setTestingChannel(id);
    try {
      const res = await fetch(`/api/channels/${id}/test`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        toast({ title: "連線成功", description: data.message });
        setHealthStatus(prev => ({ ...prev, [`channel_${id}`]: { status: "ok", message: data.message } }));
        queryClient.invalidateQueries({ queryKey: ["/api/brands", selectedBrandId, "channels"] });
      } else {
        toast({ title: "連線失敗", description: data.message, variant: "destructive" });
        setHealthStatus(prev => ({ ...prev, [`channel_${id}`]: { status: "error", message: data.message } }));
      }
    } catch (_e) {
      toast({ title: "測試失敗", variant: "destructive" });
    } finally {
      setTestingChannel(null);
    }
  };

  const handleSubscribeFeed = async (id: number) => {
    setSubscribingFeedChannelId(id);
    try {
      const res = await fetch(`/api/channels/${id}/subscribe-feed`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        toast({ title: "訂閱成功", description: data.message });
      } else {
        toast({ title: "訂閱失敗", description: data.message, variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "訂閱失敗", variant: "destructive" });
    } finally {
      setSubscribingFeedChannelId(null);
    }
  };

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
  };

  const selectedBrand = brands.find(b => b.id === selectedBrandId);

  if (!isSuperAdmin && !readOnly) return null;

  return (
    <>
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-brand-management">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><Building2 className="w-4 h-4 text-emerald-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">品牌工作區管理</span>
              <p className="text-xs text-stone-500">管理品牌與渠道（LINE / Facebook）的連線設定</p>
            </div>
          </div>
          {!readOnly && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleRefreshProfiles} disabled={refreshingProfiles} className="text-xs text-stone-500 hover:text-emerald-600" data-testid="button-refresh-profiles" title="若某品牌下 LINE 沒有大頭照，請先將該渠道 Bot ID 改為日誌 destination 後再點此按鈕">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshingProfiles ? "animate-spin" : ""}`} />
              {refreshingProfiles ? "更新中..." : "同步頭貼 (LINE / Facebook)"}
            </Button>
            <Button size="sm" variant="ghost" onClick={fetchHealthStatus} disabled={healthLoading} className="text-xs text-stone-500 hover:text-emerald-600" data-testid="button-refresh-health">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${healthLoading ? "animate-spin" : ""}`} />
              {healthLoading ? "檢測中" : "全部檢測"}
            </Button>
            <Button onClick={openAddBrand} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-brand">
              <Plus className="w-3.5 h-3.5 mr-1.5" />新增品牌
            </Button>
          </div>
          )}
        </div>

        <div className="space-y-3">
          {brands.map((brand) => {
            const slStatus = healthStatus[`superlanding_brand_${brand.id}`];
            const shoplineStatus = healthStatus[`shopline_brand_${brand.id}`];
            const agents = assignedAgentsByBrand[brand.id] ?? [];
            const assignedSummary = formatBrandAssignedSummary(agents);
            return (
              <div key={brand.id} className={`rounded-xl border p-4 transition-all ${selectedBrandId === brand.id ? "border-emerald-300 bg-emerald-50/30" : "border-stone-200 bg-stone-50/50"}`} data-testid={`brand-card-${brand.id}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {brand.logo_url ? (
                      <img src={brand.logo_url} className="w-10 h-10 rounded-xl object-cover border border-stone-200" alt="" />
                    ) : (
                      <div className="w-10 h-10 rounded-xl bg-stone-200 flex items-center justify-center"><Building2 className="w-5 h-5 text-stone-400" /></div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-stone-800">{brand.name}</p>
                        {slStatus && <StatusBadge status={slStatus.status} message={slStatus.message} />}
                        {shoplineStatus && <StatusBadge status={shoplineStatus.status} message={shoplineStatus.message} />}
                      </div>
                      <p className="text-[10px] text-stone-400">{brand.slug} · {brand.description || "尚無描述"}</p>
                      <p className="text-[10px] text-stone-500 mt-0.5" data-testid={`brand-assigned-${brand.id}`}>{assignedSummary}</p>
                    </div>
                  </div>
                  {!readOnly && (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => handleTestBrandSL(brand.id)} disabled={testingBrandSL === brand.id} className="text-xs text-stone-500 hover:text-emerald-600" data-testid={`button-test-brand-sl-${brand.id}`}>
                      {testingBrandSL === brand.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />商店</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleTestBrandShopline(brand.id)} disabled={testingBrandShopline === brand.id} className="text-xs text-stone-500 hover:text-blue-600" data-testid={`button-test-brand-shopline-${brand.id}`}>
                      {testingBrandShopline === brand.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />SHOPLINE</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setSelectedBrandId(brand.id); }} className="text-xs text-stone-500 hover:text-emerald-600" data-testid={`button-select-brand-${brand.id}`}>
                      {selectedBrandId === brand.id ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : "選取"}
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => openEditBrand(brand)} className="h-7 w-7 text-stone-400 hover:text-emerald-600" data-testid={`button-edit-brand-${brand.id}`}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => handleDeleteBrand(brand.id)} className="h-7 w-7 text-red-400 hover:text-red-600" data-testid={`button-delete-brand-${brand.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!readOnly && selectedBrand && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-channel-management">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center"><Hash className="w-4 h-4 text-blue-600" /></div>
              <div>
                <span className="text-sm font-semibold text-stone-800">{selectedBrand.name} 的渠道</span>
                <p className="text-xs text-stone-500">管理此品牌下的 LINE / Facebook 渠道</p>
              </div>
            </div>
            <Button onClick={openAddChannel} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-channel">
              <Plus className="w-3.5 h-3.5 mr-1.5" />新增渠道
            </Button>
          </div>

          {allChannels.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-stone-100 flex items-center justify-center"><Hash className="w-7 h-7 text-stone-300" /></div>
              <p className="text-sm text-stone-500">此品牌尚未建立渠道</p>
              <p className="text-xs text-stone-400 mt-1">新增 LINE 或 Facebook 渠道來接收客戶訊息</p>
            </div>
          ) : (
            <div className="space-y-2">
              {allChannels.map((ch) => {
                const chStatus = healthStatus[`channel_${ch.id}`];
                return (
                  <div key={ch.id} className="flex items-center gap-3 p-3 rounded-xl bg-stone-50 border border-stone-100" data-testid={`channel-card-${ch.id}`}>
                    <div className={`relative w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${ch.platform === "line" ? "bg-green-100" : "bg-blue-100"}`}>
                      <div className={`w-3 h-3 rounded-full ${ch.platform === "line" ? "bg-green-500" : "bg-blue-500"}`} />
                      {chStatus && (
                        <div className="absolute -top-0.5 -right-0.5">
                          <StatusDot status={chStatus.status} size="sm" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-stone-800">{ch.channel_name}</p>
                        <span className="text-[10px] text-stone-400 font-mono" title="日誌 NO MATCH 時可對照此 ID">ID:{ch.id}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ch.platform === "line" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                          {ch.platform === "line" ? "LINE" : "Messenger"}
                        </span>
                        {chStatus && <StatusBadge status={chStatus.status} message={chStatus.message} />}
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] text-stone-400 truncate">Bot ID: {ch.bot_id || "未設定"} · Token: {ch.access_token ? maskValue(ch.access_token) : "未設定"}</p>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${ch.is_ai_enabled ? "bg-emerald-50 text-emerald-600" : "bg-stone-100 text-stone-400"}`} data-testid={`badge-ai-status-${ch.id}`}>
                          AI {ch.is_ai_enabled ? "開啟" : "關閉"}
                        </span>
                      </div>
                      {ch.platform === "line" && ch.bot_id && ch.bot_id.startsWith("U") && (
                        <p className="text-[10px] text-amber-600 mt-1">Bot ID 為 U 開頭時多為 User ID，新訊息可能只出現在「全部」。請改為 Railway 日誌中的 destination 後儲存。</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {ch.access_token && (
                        <Button size="sm" variant="secondary" onClick={() => handleTestChannel(ch.id)} disabled={testingChannel === ch.id} className="text-xs h-7 bg-stone-100 hover:bg-stone-200" data-testid={`button-test-channel-${ch.id}`}>
                          {testingChannel === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />測試</>}
                        </Button>
                      )}
                      {ch.platform === "messenger" && ch.bot_id && ch.access_token && (
                        <Button size="sm" variant="outline" onClick={() => handleSubscribeFeed(ch.id)} disabled={subscribingFeedChannelId === ch.id} className="text-xs h-7 border-amber-200 text-amber-700 hover:bg-amber-50" data-testid={`button-subscribe-feed-${ch.id}`} title="讓貼文底下留言送進留言收件匣">
                          {subscribingFeedChannelId === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "訂閱留言"}
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" onClick={() => openEditChannel(ch)} className="h-7 w-7 text-stone-400 hover:text-emerald-600" data-testid={`button-edit-channel-${ch.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => handleDeleteChannel(ch.id)} className="h-7 w-7 text-red-400 hover:text-red-600" data-testid={`button-delete-channel-${ch.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!readOnly && allChannelsWithBrand.length > 0 && brands.length > 0 && (
        <div className="bg-amber-50/80 rounded-2xl border border-amber-200 p-5 shadow-sm" data-testid="section-reassign-by-channel">
          <div className="flex items-center gap-2 mb-3">
            <RefreshCw className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-semibold text-stone-800">批次修正聯絡人歸屬</span>
          </div>
          <p className="text-xs text-stone-600 mb-3">若某渠道的訊息被錯歸到別的品牌，可將「該渠道下所有聯絡人」一次改歸到正確品牌（請先修正該渠道的 Bot ID，新訊息才會持續歸對）。</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px]">
              <label className="text-xs font-medium text-stone-600 mb-1 block">選擇渠道</label>
              <Select value={reassignChannelId === "" ? "_" : String(reassignChannelId)} onValueChange={(v) => setReassignChannelId(v === "_" ? "" : parseInt(v, 10))}>
                <SelectTrigger className="bg-white border-stone-200 text-sm"><SelectValue placeholder="請選擇" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_">請選擇渠道</SelectItem>
                  {allChannelsWithBrand.map((ch) => (
                    <SelectItem key={ch.id} value={String(ch.id)}>{ch.channel_name} {ch.brand_name ? `(${ch.brand_name})` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[180px]">
              <label className="text-xs font-medium text-stone-600 mb-1 block">改歸到品牌</label>
              <Select value={reassignBrandId === "" ? "_" : String(reassignBrandId)} onValueChange={(v) => setReassignBrandId(v === "_" ? "" : parseInt(v, 10))}>
                <SelectTrigger className="bg-white border-stone-200 text-sm"><SelectValue placeholder="請選擇" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_">請選擇品牌</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleReassignByChannel} disabled={reassignLoading} className="bg-amber-600 hover:bg-amber-700 text-white text-xs">
              {reassignLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              執行
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showBrandDialog} onOpenChange={setShowBrandDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-800">{editingBrand ? "編輯品牌" : "新增品牌"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">品牌名稱 *</label>
              <Input data-testid="input-brand-name" value={brandForm.name} onChange={(e) => setBrandForm(f => ({ ...f, name: e.target.value }))} placeholder="例：Rich Bear 甜點" className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">品牌代碼 (slug)</label>
              <Input data-testid="input-brand-slug" value={brandForm.slug} onChange={(e) => setBrandForm(f => ({ ...f, slug: e.target.value }))} placeholder="例：rich-bear" className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">Logo 圖片網址</label>
              <Input data-testid="input-brand-logo" value={brandForm.logo_url} onChange={(e) => setBrandForm(f => ({ ...f, logo_url: e.target.value }))} placeholder="https://..." className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">品牌描述</label>
              <Input data-testid="input-brand-desc" value={brandForm.description} onChange={(e) => setBrandForm(f => ({ ...f, description: e.target.value }))} placeholder="簡短描述品牌" className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">品牌專屬 AI 系統指令</label>
              <Textarea data-testid="textarea-brand-prompt" value={brandForm.system_prompt} onChange={(e) => setBrandForm(f => ({ ...f, system_prompt: e.target.value }))} placeholder="此品牌的 AI 客服人設與回覆風格..." className="min-h-[80px] resize-y text-sm bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">退換貨表單連結 (Google Form 等)</label>
              <Input data-testid="input-brand-return-url" value={brandForm.return_form_url} onChange={(e) => setBrandForm(f => ({ ...f, return_form_url: e.target.value }))} placeholder="https://forms.gle/..." className="bg-stone-50 border-stone-200" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">一頁商店 Merchant No</label>
                <Input data-testid="input-brand-merchant" value={brandForm.superlanding_merchant_no} onChange={(e) => setBrandForm(f => ({ ...f, superlanding_merchant_no: e.target.value }))} placeholder="商店編號" className="bg-stone-50 border-stone-200" />
              </div>
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">一頁商店 Access Key</label>
                <Input data-testid="input-brand-access-key" value={brandForm.superlanding_access_key} onChange={(e) => setBrandForm(f => ({ ...f, superlanding_access_key: e.target.value }))} placeholder="存取金鑰" className="bg-stone-50 border-stone-200" />
              </div>
            </div>
            <div className="pt-2 border-t border-stone-100">
              <label className="text-xs font-semibold text-stone-700 mb-2 block">SHOPLINE 訂單查詢</label>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="text-xs font-medium text-stone-600 mb-1 block">SHOPLINE 商店域名</label>
                  <Input data-testid="input-brand-shopline-domain" value={brandForm.shopline_store_domain} onChange={(e) => setBrandForm(f => ({ ...f, shopline_store_domain: e.target.value }))} placeholder="your-store.myshopline.com" className="bg-stone-50 border-stone-200" />
                </div>
                <div>
                  <label className="text-xs font-medium text-stone-600 mb-1 block">SHOPLINE API Token</label>
                  <Input data-testid="input-brand-shopline-token" type="password" value={brandForm.shopline_api_token} onChange={(e) => setBrandForm(f => ({ ...f, shopline_api_token: e.target.value }))} placeholder="輸入 SHOPLINE API Token" className="bg-stone-50 border-stone-200" />
                </div>
              </div>
            </div>
            {editingBrand && (
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex items-center justify-between">
                  {healthStatus[`superlanding_brand_${editingBrand.id}`] && (
                    <StatusBadge
                      status={healthStatus[`superlanding_brand_${editingBrand.id}`].status}
                      message={healthStatus[`superlanding_brand_${editingBrand.id}`].message}
                    />
                  )}
                  <Button size="sm" variant="secondary" onClick={() => handleTestBrandSL(editingBrand.id)} disabled={testingBrandSL === editingBrand.id} className="text-xs bg-stone-100 hover:bg-stone-200 ml-auto" data-testid="button-test-brand-sl-dialog">
                    {testingBrandSL === editingBrand.id ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試一頁商店連線</>}
                  </Button>
                </div>
                <div className="flex items-center justify-between">
                  {healthStatus[`shopline_brand_${editingBrand.id}`] && (
                    <StatusBadge
                      status={healthStatus[`shopline_brand_${editingBrand.id}`].status}
                      message={healthStatus[`shopline_brand_${editingBrand.id}`].message}
                    />
                  )}
                  <Button size="sm" variant="secondary" onClick={() => handleTestBrandShopline(editingBrand.id)} disabled={testingBrandShopline === editingBrand.id} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 ml-auto" data-testid="button-test-brand-shopline-dialog">
                    {testingBrandShopline === editingBrand.id ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試 SHOPLINE 連線</>}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowBrandDialog(false)} className="text-xs">取消</Button>
            <Button onClick={handleSaveBrand} disabled={brandSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-save-brand">
              {brandSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1" />}
              {editingBrand ? "更新" : "建立"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showChannelDialog} onOpenChange={setShowChannelDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-stone-800">{editingChannel ? "編輯渠道" : "新增渠道"}</DialogTitle>
            {!editingChannel && selectedBrand && (
              <p className="text-xs text-stone-500 mt-1">此渠道將隸屬於：<strong className="text-stone-700">{selectedBrand.name}</strong></p>
            )}
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">平台 *</label>
              <Select value={channelForm.platform} onValueChange={(v) => setChannelForm(f => ({ ...f, platform: v as ChannelPlatform }))}>
                <SelectTrigger className="bg-stone-50 border-stone-200" data-testid="select-channel-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="line">LINE</SelectItem>
                  <SelectItem value="messenger">Facebook Messenger</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">渠道名稱 *</label>
              <Input data-testid="input-channel-name" value={channelForm.channel_name} onChange={(e) => setChannelForm(f => ({ ...f, channel_name: e.target.value }))} placeholder="例：Rich Bear 官方 LINE" className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">
                Bot ID ({channelForm.platform === "line" ? "LINE Webhook 的 destination" : "Facebook Page ID"})
              </label>
              <Input data-testid="input-channel-bot-id" value={channelForm.bot_id} onChange={(e) => setChannelForm(f => ({ ...f, bot_id: e.target.value }))} placeholder={channelForm.platform === "line" ? "從 Railway 日誌 [WEBHOOK] destination: 複製貼上" : "Page ID"} className="bg-stone-50 border-stone-200" />
              <p className="text-[10px] text-stone-400 mt-1">
                {channelForm.platform === "line"
                  ? "每個 LINE 機器人（如私藏生活、AQUILA 天鷹座）的 destination 都不同。此欄位請填「本渠道」對應的機器人在日誌 [WEBHOOK] destination 的值，須完全一致；勿與其他渠道混用。日誌 NO MATCH 時會列出各渠道 channel_id／名稱／bot_id 可對照。"
                  : "用於識別 Facebook 頁面的唯一 ID"}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">
                {channelForm.platform === "line" ? "Channel Access Token" : "Page Access Token"}
              </label>
              <div className="relative">
                <Input data-testid="input-channel-token" type={showKeys["ch_token"] ? "text" : "password"} value={channelForm.access_token} onChange={(e) => setChannelForm(f => ({ ...f, access_token: e.target.value }))} placeholder="輸入存取權杖" className="pr-10 bg-stone-50 border-stone-200" />
                <button type="button" onClick={() => setShowKeys(s => ({ ...s, ch_token: !s.ch_token }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                  {showKeys["ch_token"] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">
                {channelForm.platform === "line" ? "Channel Secret" : "App Secret"}
              </label>
              <div className="relative">
                <Input data-testid="input-channel-secret" type={showKeys["ch_secret"] ? "text" : "password"} value={channelForm.channel_secret} onChange={(e) => setChannelForm(f => ({ ...f, channel_secret: e.target.value }))} placeholder="輸入密鑰" className="pr-10 bg-stone-50 border-stone-200" />
                <button type="button" onClick={() => setShowKeys(s => ({ ...s, ch_secret: !s.ch_secret }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                  {showKeys["ch_secret"] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {channelForm.platform === "line" && (
            <div className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
              <p className="text-[11px] text-stone-500 mb-2">儲存前可先驗證 Token 是否有效，以及 Bot ID 是否與 LINE 回傳的 userId（Webhook destination）一致</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleVerifyLineConnection}
                disabled={channelVerifying || !channelForm.access_token?.trim()}
                className="text-xs"
              >
                {channelVerifying ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plug className="w-3.5 h-3.5 mr-1" />}
                驗證連線
              </Button>
            </div>
          )}
            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
              <div>
                <label className="text-sm font-medium text-stone-700">啟用 AI 自動回覆</label>
                <p className="text-[11px] text-stone-400 mt-0.5">關閉後，此渠道收到的訊息將不會觸發 AI 回覆，僅保留人工處理</p>
              </div>
              <Switch
                data-testid="switch-ai-enabled"
                checked={channelForm.is_ai_enabled === 1}
                onCheckedChange={(checked) => setChannelForm(f => ({ ...f, is_ai_enabled: checked ? 1 : 0 }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowChannelDialog(false)} className="text-xs">取消</Button>
            <Button onClick={handleSaveChannel} disabled={channelSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-save-channel">
              {channelSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1" />}
              {editingChannel ? "更新" : "建立"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
