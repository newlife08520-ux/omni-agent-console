import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Settings, Brain, Users, ChevronRight, BarChart3, Building2, ChevronDown, Target, Inbox, MessageCircle, AlertTriangle, UserPlus, ClipboardList, Clock, MessagesSquare, FlaskConical } from "lucide-react";
import { useBrand } from "@/lib/brand-context";
import { useChatView, type ViewMode } from "@/lib/chat-view-context";
import { useState } from "react";
import { getQueryFn } from "@/lib/queryClient";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/** P0-A: 導航改為獨立 path，不再用 hash 假模組 */
const allMenuItems = [
  { title: "即時客服", url: "/", icon: MessageSquare, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "對話與案件處理" },
  { title: "留言收件匣", url: "/comment-center/inbox", icon: MessagesSquare, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "預設只看例外，監控 AI 處理狀態" },
  { title: "留言規則與導向", url: "/comment-center/rules", icon: ClipboardList, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "自動規則、模板對應、風險與導流" },
  { title: "粉專與 LINE 設定", url: "/comment-center/channel-binding", icon: MessageCircle, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "粉專導向哪個 LINE 一眼看清" },
  { title: "內測模擬", url: "/comment-center/simulate", icon: FlaskConical, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "模擬留言與 webhook 測試" },
  { title: "客服績效", url: "/performance", icon: Target, roles: ["super_admin", "marketing_manager", "cs_agent"], desc: "個人與團隊表現" },
  { title: "AI 與知識庫", url: "/knowledge", icon: Brain, roles: ["super_admin", "marketing_manager"], desc: "AI 設定與知識管理" },
  { title: "數據戰情室", url: "/analytics", icon: BarChart3, roles: ["super_admin", "marketing_manager"], desc: "數據與報表" },
  { title: "團隊管理", url: "/team", icon: Users, roles: ["super_admin", "marketing_manager"], desc: "成員、排班與派案規則" },
  { title: "品牌與渠道", url: "/settings/brands-channels", icon: Building2, roles: ["super_admin", "marketing_manager"], desc: "品牌、渠道、粉專與 LINE 綁定" },
  { title: "系統設定", url: "/settings", icon: Settings, roles: ["super_admin", "marketing_manager"], desc: "全域設定" },
];

const ROLE_LABEL: Record<string, string> = {
  super_admin: "管理員",
  marketing_manager: "主管",
  cs_agent: "客服",
};

interface AppSidebarProps {
  user?: { display_name?: string; username?: string; role: string };
  userRole: string;
  systemName: string;
  logoUrl: string;
}

export function AppSidebar({ user, userRole, systemName, logoUrl }: AppSidebarProps) {
  const [location, setLocation] = useLocation();
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const { viewMode, setViewMode } = useChatView();
  const pathname = typeof location === "string" ? location : (location as { pathname?: string })?.pathname ?? "/";
  const menuItems = allMenuItems.filter((item) => item.roles.includes(userRole));
  const { brands, selectedBrandId, setSelectedBrandId, selectedBrand, channels } = useBrand();

  const handleViewShortcut = (vm: ViewMode) => {
    setViewMode(vm);
    setLocation("/");
  };

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 30000,
  });
  const unreadCount = unreadData?.count ?? 0;

  const channelsList = Array.isArray(channels) ? channels : [];
  const activeChannelCount = channelsList.filter((c) => c.is_active).length;
  const displayName = user?.display_name ?? user?.username ?? "—";
  const isEmployee = userRole === "cs_agent";

  const { data: agentStats } = useQuery<{ my_cases: number; pending_reply: number; urgent: number; overdue?: number; tracking?: number; closed_today?: number; open_cases_count: number; max_active_conversations: number; is_online?: number; is_available?: number }>({
    queryKey: ["/api/agent-stats/me"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: isEmployee,
    refetchInterval: 15000,
  });

  const loadText = agentStats != null && agentStats.max_active_conversations > 0
    ? `${agentStats.open_cases_count}/${agentStats.max_active_conversations}`
    : null;

  const isManager = userRole === "super_admin" || userRole === "marketing_manager";
  const { data: managerStats } = useQuery<{
    today_new: number;
    unassigned: number;
    urgent: number;
    overdue: number;
    closed_today: number;
    vip_unhandled: number;
    team: { id: number; display_name: string; is_online: number; is_available: number; open_cases_count: number; max_active_conversations: number; pending_reply: number }[];
  }>({
    queryKey: ["/api/manager-stats", selectedBrandId ?? "all"],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/manager-stats?brand_id=${selectedBrandId}` : "/api/manager-stats";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
    enabled: isManager,
    refetchInterval: 15000,
  });

  return (
    <aside className="w-[260px] min-w-[260px] bg-stone-800 text-white flex flex-col h-screen" data-testid="sidebar">
      {/* 左上：目前登入者（員工版加強：在線、負載） */}
      <div className="p-4 border-b border-stone-700/50 bg-stone-800/95">
        <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider mb-2.5">目前登入</p>
        <div className="flex items-center gap-3">
          <Avatar className="w-11 h-11 shrink-0 border-2 border-stone-600 ring-2 ring-emerald-500/30">
            <AvatarFallback className="bg-emerald-600 text-white text-sm font-bold">
              {displayName ? String(displayName).trim().slice(0, 1).toUpperCase() || "?" : "?"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white truncate" data-testid="text-current-user">{displayName}</p>
            <p className="text-[11px] text-stone-400">{ROLE_LABEL[userRole] || userRole}</p>
            {isEmployee && (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {agentStats?.is_online === 1 && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />在線
                  </span>
                )}
                {loadText != null && (
                  <span className="text-[10px] text-stone-500">負載 {loadText}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 員工版：我的工作摘要（文案收斂） */}
      {isEmployee && (
        <div className="px-3 pt-4 pb-1">
          <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">我的工作</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
              <p className="text-[10px] text-stone-400">我的</p>
              <p className="text-lg font-bold text-white tabular-nums">{agentStats?.my_cases ?? "—"}</p>
            </div>
            <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
              <p className="text-[10px] text-stone-400">待回</p>
              <p className="text-lg font-bold text-amber-400 tabular-nums">{agentStats?.pending_reply ?? "—"}</p>
            </div>
            <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
              <p className="text-[10px] text-stone-400">緊急</p>
              <p className="text-lg font-bold text-red-400 tabular-nums">{agentStats?.urgent ?? "—"}</p>
            </div>
            <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
              <p className="text-[10px] text-stone-400">追蹤</p>
              <p className="text-lg font-bold text-sky-400 tabular-nums">{agentStats?.tracking ?? "—"}</p>
            </div>
            {(agentStats?.overdue != null || agentStats?.closed_today != null) && (
              <>
                <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
                  <p className="text-[10px] text-stone-400">逾時</p>
                  <p className="text-lg font-bold text-orange-400 tabular-nums">{agentStats?.overdue ?? "—"}</p>
                </div>
                <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
                  <p className="text-[10px] text-stone-400">結案</p>
                  <p className="text-lg font-bold text-emerald-400 tabular-nums">{agentStats?.closed_today ?? "—"}</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 員工版：我的快捷區（與上方 tab 共用 viewMode） */}
      {isEmployee && (
        <div className="px-3 pt-3 pb-1">
          <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">我的快捷</p>
          <div className="space-y-1">
            {([
              { vm: "my" as ViewMode, label: "我的案件", Icon: Inbox, color: "text-stone-400", count: agentStats?.my_cases },
              { vm: "pending" as ViewMode, label: "待我回覆", Icon: MessageCircle, color: "text-amber-400", count: agentStats?.pending_reply },
              { vm: "high_risk" as ViewMode, label: "緊急案件", Icon: AlertTriangle, color: "text-red-400", count: agentStats?.urgent },
              { vm: "tracking" as ViewMode, label: "待追蹤", Icon: Target, color: "text-sky-400", count: agentStats?.tracking },
              { vm: "unassigned" as ViewMode, label: "待分配", Icon: UserPlus, color: "text-stone-400", count: undefined },
            ]).map(({ vm, label, Icon, color, count }) => (
              <button key={vm} type="button" onClick={() => handleViewShortcut(vm)} className="block w-full text-left">
                <div className={`flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all ${viewMode === vm ? "bg-stone-600 ring-1 ring-stone-500" : "bg-stone-700/50 hover:bg-stone-700"}`}>
                  <Icon className={`w-4 h-4 shrink-0 ${viewMode === vm ? "text-white" : color}`} />
                  <span className={`text-xs font-medium flex-1 ${viewMode === vm ? "text-white" : "text-stone-200"}`}>{label}</span>
                  {count != null && <span className={`text-[10px] tabular-nums ${viewMode === vm ? "text-stone-300" : color}`}>{count}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主管版：今日戰情摘要 + 團隊狀況 + 主管快捷 */}
      {isManager && (
        <>
          <div className="px-3 pt-4 pb-1">
            <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">今日戰情</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
                <p className="text-[10px] text-stone-400">今日新進</p>
                <p className="text-lg font-bold text-white tabular-nums">{managerStats?.today_new ?? "—"}</p>
              </div>
              <button type="button" onClick={() => handleViewShortcut("unassigned")} className="rounded-xl bg-stone-700/50 px-3 py-2.5 text-left hover:bg-stone-700 transition-colors">
                <p className="text-[10px] text-stone-400">待分配</p>
                <p className="text-lg font-bold text-amber-400 tabular-nums">{managerStats?.unassigned ?? "—"}</p>
              </button>
              <button type="button" onClick={() => handleViewShortcut("high_risk")} className="rounded-xl bg-stone-700/50 px-3 py-2.5 text-left hover:bg-stone-700 transition-colors">
                <p className="text-[10px] text-stone-400">緊急</p>
                <p className="text-lg font-bold text-red-400 tabular-nums">{managerStats?.urgent ?? "—"}</p>
              </button>
              <button type="button" onClick={() => handleViewShortcut("overdue")} className="rounded-xl bg-stone-700/50 px-3 py-2.5 text-left hover:bg-stone-700 transition-colors">
                <p className="text-[10px] text-stone-400">逾時</p>
                <p className="text-lg font-bold text-orange-400 tabular-nums">{managerStats?.overdue ?? "—"}</p>
              </button>
              <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
                <p className="text-[10px] text-stone-400">結案</p>
                <p className="text-lg font-bold text-emerald-400 tabular-nums">{managerStats?.closed_today ?? "—"}</p>
              </div>
              <div className="rounded-xl bg-stone-700/50 px-3 py-2.5">
                <p className="text-[10px] text-stone-400">VIP待處理</p>
                <p className="text-lg font-bold text-rose-400 tabular-nums">{managerStats?.vip_unhandled ?? "—"}</p>
              </div>
            </div>
          </div>
          {managerStats?.team && managerStats.team.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">團隊狀況</p>
              <div className="space-y-1 max-h-[140px] overflow-y-auto">
                {managerStats.team.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-stone-700/50">
                    <span className="text-[11px] text-stone-300 truncate">{m.display_name}</span>
                    <span className={`text-[10px] shrink-0 ${m.is_online === 1 ? "text-emerald-400" : "text-stone-500"}`}>
                      {m.is_online === 1 ? "在線" : "離線"}
                    </span>
                    <span className="text-[10px] text-stone-500 tabular-nums shrink-0">{m.open_cases_count}/{m.max_active_conversations}</span>
                    {m.pending_reply > 0 && <span className="text-[10px] text-amber-400 tabular-nums">{m.pending_reply} 待回</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="px-3 pt-3 pb-1">
            <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">主管快捷</p>
            <div className="space-y-1">
              {([
                { vm: "unassigned" as ViewMode, label: "待分配", Icon: UserPlus, color: "text-amber-400", count: managerStats?.unassigned },
                { vm: "overdue" as ViewMode, label: "逾時未回", Icon: Clock, color: "text-orange-400", count: managerStats?.overdue },
                { vm: "all" as ViewMode, label: "全部案件", Icon: ClipboardList, color: "text-stone-400", count: undefined },
              ]).map(({ vm, label, Icon, color, count }) => (
                <button key={vm} type="button" onClick={() => handleViewShortcut(vm)} className="block w-full text-left">
                  <div className={`flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all ${viewMode === vm ? "bg-stone-600 ring-1 ring-stone-500" : "bg-stone-700/50 hover:bg-stone-700"}`}>
                    <Icon className={`w-4 h-4 shrink-0 ${viewMode === vm ? "text-white" : color}`} />
                    <span className={`text-xs font-medium flex-1 ${viewMode === vm ? "text-white" : "text-stone-200"}`}>{label}</span>
                    {count != null && <span className={`text-[10px] tabular-nums ${viewMode === vm ? "text-stone-300" : color}`}>{count}</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="px-3 pt-4 pb-1">
        <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2.5">品牌工作區</p>
        <div className="relative">
          <button
            onClick={() => setBrandMenuOpen(!brandMenuOpen)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-stone-700/50 hover:bg-stone-700 transition-all text-left"
            data-testid="button-brand-selector"
          >
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-600/20 shrink-0">
              <Building2 className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate text-stone-200" data-testid="text-current-brand">
                {selectedBrandId == null ? "全部" : (selectedBrand?.name ?? "選擇品牌")}
              </p>
              <p className="text-[10px] text-stone-500 truncate">
                {selectedBrandId == null ? "不依品牌篩選" : (activeChannelCount > 0 ? `${activeChannelCount} 個渠道` : "尚無渠道")}
              </p>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-stone-400 transition-transform ${brandMenuOpen ? "rotate-180" : ""}`} />
          </button>

          {brandMenuOpen && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-stone-700 rounded-xl border border-stone-600/50 shadow-xl overflow-hidden">
              <button
                onClick={() => { setSelectedBrandId(null); setBrandMenuOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all ${
                  selectedBrandId === null ? "bg-emerald-600/20 text-emerald-300" : "text-stone-300 hover:bg-stone-600/50"
                }`}
                data-testid="button-brand-all"
              >
                <div className="w-6 h-6 rounded-md bg-stone-600 flex items-center justify-center shrink-0">
                  <Building2 className="w-3 h-3 text-stone-400" />
                </div>
                <span className="text-xs truncate flex-1">全部</span>
                {selectedBrandId === null && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
              </button>
              {brands.map((brand) => (
                <button
                  key={brand.id}
                  onClick={() => { setSelectedBrandId(brand.id); setBrandMenuOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-all ${
                    selectedBrandId === brand.id ? "bg-emerald-600/20 text-emerald-300" : "text-stone-300 hover:bg-stone-600/50"
                  }`}
                  data-testid={`button-brand-${brand.id}`}
                >
                  {brand.logo_url ? (
                    <img src={brand.logo_url} className="w-6 h-6 rounded-md object-cover shrink-0" alt="" />
                  ) : (
                    <div className="w-6 h-6 rounded-md bg-stone-600 flex items-center justify-center shrink-0">
                      <Building2 className="w-3 h-3 text-stone-400" />
                    </div>
                  )}
                  <span className="text-xs truncate flex-1">{brand.name}</span>
                  {selectedBrandId === brand.id && <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {channels.length > 0 && (
          <div className="mt-2 space-y-0.5 px-1">
            {channels.map((ch) => (
              <div key={ch.id} className="flex items-center gap-2 px-2 py-1 rounded-lg" data-testid={`channel-${ch.id}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${ch.is_active ? (ch.platform === "line" ? "bg-green-400" : "bg-blue-400") : "bg-stone-500"}`} />
                <span className={`text-[10px] ${ch.platform === "line" ? "text-green-400" : "text-blue-400"}`}>
                  {ch.platform === "line" ? "LINE" : "FB"}
                </span>
                <span className="text-[10px] text-stone-400 truncate flex-1">{ch.channel_name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-3">功能選單</p>
        <div className="space-y-0.5">
          {menuItems.map((item) => {
            const isActive = item.url === "/" ? pathname === "/" : pathname.startsWith(item.url);
            const showBadge = item.url === "/" && unreadCount > 0;
            const desc = "desc" in item ? (item as { desc?: string }).desc : undefined;
            return (
              <Link key={item.title} href={item.url} data-testid={`link-${item.url.replace("/", "") || "chat"}`}>
                <div className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-all cursor-pointer border-l-2 ${
                  isActive
                    ? "bg-emerald-600/20 text-emerald-400 border-emerald-500"
                    : "border-transparent text-stone-300 hover:bg-stone-700/50 hover:text-white"
                }`}>
                  <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${isActive ? "bg-emerald-600/30" : "bg-stone-700/50"}`}>
                    <item.icon className="w-[18px] h-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    {desc && <p className="text-[10px] text-stone-500 truncate mt-0.5">{desc}</p>}
                  </div>
                  {showBadge && (
                    <span className="min-w-[20px] h-[20px] px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold shrink-0">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                  {isActive && !showBadge && <ChevronRight className="w-4 h-4 text-emerald-400 shrink-0" />}
                </div>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="p-4 border-t border-stone-700/50 bg-stone-800/80">
        <div className="flex items-center gap-2 px-1">
          <div className={`w-2 h-2 rounded-full shrink-0 ${activeChannelCount > 0 ? "bg-emerald-400 animate-pulse" : "bg-stone-500"}`} />
          <span className="text-[11px] text-stone-400">
            {activeChannelCount > 0 ? `${activeChannelCount} 個渠道啟用中` : "尚未設定渠道"}
          </span>
        </div>
      </div>
    </aside>
  );
}
