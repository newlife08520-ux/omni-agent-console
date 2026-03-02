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
  Eye, EyeOff, Save, Key, Shield, MessageSquare, Plug, Loader2, Palette, Type, Image,
  MessageCircle, Zap, AlertTriangle, ShoppingBag, Building2, Plus, Pencil, Trash2,
  Hash, CheckCircle, XCircle, ExternalLink, RefreshCw, Wifi, WifiOff, CircleDot,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import { useToast } from "@/hooks/use-toast";
import type { Setting, Brand, Channel, ChannelPlatform } from "@shared/schema";

interface SettingsPageProps {
  userRole?: string;
}

type HealthStatus = "ok" | "error" | "unconfigured" | "loading" | "unknown";

interface HealthEntry { status: HealthStatus; message: string }

function StatusDot({ status, size = "sm" }: { status: HealthStatus; size?: "sm" | "md" }) {
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

function StatusBadge({ status, message }: { status: HealthStatus; message?: string }) {
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

function BrandChannelManager({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { brands, selectedBrandId, setSelectedBrandId } = useBrand();

  const [showBrandDialog, setShowBrandDialog] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [brandForm, setBrandForm] = useState({ 
    name: "", slug: "", logo_url: "", description: "", system_prompt: "", 
    superlanding_merchant_no: "", superlanding_access_key: "",
    return_form_url: "" 
  });
  const [brandSaving, setBrandSaving] = useState(false);

  const [showChannelDialog, setShowChannelDialog] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [channelForm, setChannelForm] = useState({ platform: "line" as ChannelPlatform, channel_name: "", bot_id: "", access_token: "", channel_secret: "" });
  const [channelSaving, setChannelSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<number | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [healthStatus, setHealthStatus] = useState<Record<string, HealthEntry>>({});
  const [healthLoading, setHealthLoading] = useState(false);
  const [testingBrandSL, setTestingBrandSL] = useState<number | null>(null);
  const [refreshingProfiles, setRefreshingProfiles] = useState(false);

  const handleRefreshProfiles = async () => {
    setRefreshingProfiles(true);
    try {
      const res = await fetch("/api/admin/refresh-profiles", { method: "POST", credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        toast({ title: "LINE 頭貼更新完成", description: `共 ${data.total} 位聯絡人，成功更新 ${data.updated} 位${data.failed > 0 ? `，失敗 ${data.failed} 位` : ""}` });
      } else {
        toast({ title: "更新失敗", variant: "destructive" });
      }
    } catch { toast({ title: "更新失敗", variant: "destructive" }); }
    finally { setRefreshingProfiles(false); }
  };

  const fetchHealthStatus = async () => {
    setHealthLoading(true);
    try {
      const res = await fetch("/api/health/status", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setHealthStatus(data);
      }
    } catch {}
    finally { setHealthLoading(false); }
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
    } catch { toast({ title: "測試失敗", variant: "destructive" }); }
    finally { setTestingBrandSL(null); }
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

  const openAddBrand = () => {
    setEditingBrand(null);
    setBrandForm({ 
      name: "", slug: "", logo_url: "", description: "", system_prompt: "", 
      superlanding_merchant_no: "", superlanding_access_key: "",
      return_form_url: "" 
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
    });
    setShowBrandDialog(true);
  };

  const handleSaveBrand = async () => {
    if (!brandForm.name.trim()) { toast({ title: "品牌名稱為必填", variant: "destructive" }); return; }
    setBrandSaving(true);
    try {
      if (editingBrand) {
        await apiRequest("PUT", `/api/brands/${editingBrand.id}`, brandForm);
      } else {
        const slug = brandForm.slug || brandForm.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-\u4e00-\u9fff]/g, "");
        await apiRequest("POST", "/api/brands", { ...brandForm, slug });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      toast({ title: editingBrand ? "品牌已更新" : "品牌已建立" });
      setShowBrandDialog(false);
    } catch { toast({ title: "操作失敗", variant: "destructive" }); }
    finally { setBrandSaving(false); }
  };

  const handleDeleteBrand = async (id: number) => {
    if (brands.length <= 1) { toast({ title: "無法刪除", description: "至少需保留一個品牌", variant: "destructive" }); return; }
    try {
      await apiRequest("DELETE", `/api/brands/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
      if (selectedBrandId === id) setSelectedBrandId(brands.find(b => b.id !== id)?.id || null);
      toast({ title: "品牌已刪除" });
    } catch { toast({ title: "刪除失敗", variant: "destructive" }); }
  };

  const openAddChannel = () => {
    setEditingChannel(null);
    setChannelForm({ platform: "line", channel_name: "", bot_id: "", access_token: "", channel_secret: "" });
    setShowChannelDialog(true);
  };

  const openEditChannel = (ch: Channel) => {
    setEditingChannel(ch);
    setChannelForm({ platform: ch.platform as ChannelPlatform, channel_name: ch.channel_name, bot_id: ch.bot_id, access_token: ch.access_token, channel_secret: ch.channel_secret });
    setShowChannelDialog(true);
  };

  const handleSaveChannel = async () => {
    if (!channelForm.channel_name.trim()) { toast({ title: "渠道名稱為必填", variant: "destructive" }); return; }
    setChannelSaving(true);
    try {
      if (editingChannel) {
        await apiRequest("PUT", `/api/channels/${editingChannel.id}`, channelForm);
      } else {
        await apiRequest("POST", `/api/brands/${selectedBrandId}/channels`, channelForm);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/brands", selectedBrandId, "channels"] });
      toast({ title: editingChannel ? "渠道已更新" : "渠道已建立" });
      setShowChannelDialog(false);
    } catch { toast({ title: "操作失敗", variant: "destructive" }); }
    finally { setChannelSaving(false); }
  };

  const handleDeleteChannel = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/channels/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/brands", selectedBrandId, "channels"] });
      toast({ title: "渠道已刪除" });
    } catch { toast({ title: "刪除失敗", variant: "destructive" }); }
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
    } catch { toast({ title: "測試失敗", variant: "destructive" }); }
    finally { setTestingChannel(null); }
  };

  const maskValue = (value: string) => {
    if (!value) return "";
    if (value.length <= 8) return "*".repeat(value.length);
    return value.substring(0, 4) + "*".repeat(Math.min(value.length - 8, 20)) + value.substring(value.length - 4);
  };

  const selectedBrand = brands.find(b => b.id === selectedBrandId);

  if (!isSuperAdmin) return null;

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
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleRefreshProfiles} disabled={refreshingProfiles} className="text-xs text-stone-500 hover:text-emerald-600" data-testid="button-refresh-profiles">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshingProfiles ? "animate-spin" : ""}`} />
              {refreshingProfiles ? "更新中..." : "同步 LINE 頭貼"}
            </Button>
            <Button size="sm" variant="ghost" onClick={fetchHealthStatus} disabled={healthLoading} className="text-xs text-stone-500 hover:text-emerald-600" data-testid="button-refresh-health">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${healthLoading ? "animate-spin" : ""}`} />
              {healthLoading ? "檢測中" : "全部檢測"}
            </Button>
            <Button onClick={openAddBrand} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-brand">
              <Plus className="w-3.5 h-3.5 mr-1.5" />新增品牌
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {brands.map((brand) => {
            const slStatus = healthStatus[`superlanding_brand_${brand.id}`];
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
                      {slStatus && <StatusBadge status={slStatus.status as HealthStatus} message={slStatus.message} />}
                    </div>
                    <p className="text-[10px] text-stone-400">{brand.slug} · {brand.description || "尚無描述"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => handleTestBrandSL(brand.id)} disabled={testingBrandSL === brand.id} className="text-xs text-stone-500 hover:text-emerald-600" data-testid={`button-test-brand-sl-${brand.id}`}>
                    {testingBrandSL === brand.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />商店</>}
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
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {selectedBrand && (
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
                        <StatusDot status={chStatus.status as HealthStatus} size="sm" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-stone-800">{ch.channel_name}</p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ch.platform === "line" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                        {ch.platform === "line" ? "LINE" : "Messenger"}
                      </span>
                      {chStatus && <StatusBadge status={chStatus.status as HealthStatus} message={chStatus.message} />}
                    </div>
                    <p className="text-[10px] text-stone-400 truncate">Bot ID: {ch.bot_id || "未設定"} · Token: {ch.access_token ? maskValue(ch.access_token) : "未設定"}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {ch.access_token && (
                      <Button size="sm" variant="secondary" onClick={() => handleTestChannel(ch.id)} disabled={testingChannel === ch.id} className="text-xs h-7 bg-stone-100 hover:bg-stone-200" data-testid={`button-test-channel-${ch.id}`}>
                        {testingChannel === ch.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Plug className="w-3 h-3 mr-1" />測試</>}
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
            {editingBrand && (
              <div className="flex items-center justify-between pt-1">
                {healthStatus[`superlanding_brand_${editingBrand.id}`] && (
                  <StatusBadge
                    status={healthStatus[`superlanding_brand_${editingBrand.id}`].status as HealthStatus}
                    message={healthStatus[`superlanding_brand_${editingBrand.id}`].message}
                  />
                )}
                <Button size="sm" variant="secondary" onClick={() => handleTestBrandSL(editingBrand.id)} disabled={testingBrandSL === editingBrand.id} className="text-xs bg-stone-100 hover:bg-stone-200 ml-auto" data-testid="button-test-brand-sl-dialog">
                  {testingBrandSL === editingBrand.id ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試一頁商店連線</>}
                </Button>
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
                Bot ID ({channelForm.platform === "line" ? "LINE Bot UserId" : "Facebook Page ID"})
              </label>
              <Input data-testid="input-channel-bot-id" value={channelForm.bot_id} onChange={(e) => setChannelForm(f => ({ ...f, bot_id: e.target.value }))} placeholder={channelForm.platform === "line" ? "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" : "Page ID"} className="bg-stone-50 border-stone-200" />
              <p className="text-[10px] text-stone-400 mt-1">
                {channelForm.platform === "line" ? "Webhook 會透過 destination 欄位比對此 ID 來路由訊息" : "用於識別 Facebook 頁面的唯一 ID"}
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
    } catch {
      toast({ title: "連線失敗", description: "無法連線至伺服器", variant: "destructive" });
      updateApiHealth(type, { status: "error", message: "無法連線至伺服器" });
    }
    finally { setTesting(""); }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入設定中...</p></div>;
  }

  const apiKeyFields = [
    { key: "openai_api_key", label: "OpenAI API 金鑰", icon: Key, placeholder: "sk-...", description: "用於 AI 自動回覆功能 (模型: gpt-5.2)", testType: "openai" },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="settings-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-settings-title">系統設定</h1>
        <p className="text-sm text-stone-500 mt-1">
          {isSuperAdmin ? "管理品牌工作區、渠道連線、API 金鑰與各項系統設定" : "管理品牌外觀、LINE 迎賓與轉人工設定"}
        </p>
      </div>

      <BrandChannelManager isSuperAdmin={isSuperAdmin} />

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
                    <Input data-testid={`input-${field.key}`} type={showKeys[field.key] ? "text" : "password"} placeholder={field.placeholder}
                      value={formValues[field.key] || ""}
                      onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      className="pr-10 bg-stone-50 border-stone-200" />
                    <button type="button" onClick={() => toggleKeyVisibility(field.key)} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600" data-testid={`button-toggle-${field.key}`}>
                      {showKeys[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {field.testType && (
                    <Button variant="secondary" onClick={() => handleTestConnectionWithStatus(field.testType!)} disabled={testing === field.testType} data-testid={`button-test-${field.key}`} className="text-xs shrink-0 bg-stone-100 hover:bg-stone-200">
                      {testing === field.testType ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />測試中</> : <><Plug className="w-3.5 h-3.5 mr-1" />測試連線</>}
                    </Button>
                  )}
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
        </>
      )}
    </div>
  );
}
