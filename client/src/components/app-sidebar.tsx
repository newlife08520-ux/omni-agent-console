import { Link, useLocation } from "wouter";
import { MessageSquare, Settings, Brain, Bot, Users, ChevronRight, BarChart3, Building2, ChevronDown, Plus, Hash } from "lucide-react";
import { useBrand } from "@/lib/brand-context";
import { useState } from "react";

const allMenuItems = [
  { title: "即時客服", url: "/", icon: MessageSquare, roles: ["super_admin", "marketing_manager", "cs_agent"] },
  { title: "AI 與知識庫", url: "/knowledge", icon: Brain, roles: ["super_admin", "marketing_manager"] },
  { title: "數據戰情室", url: "/analytics", icon: BarChart3, roles: ["super_admin", "marketing_manager"] },
  { title: "團隊管理", url: "/team", icon: Users, roles: ["super_admin"] },
  { title: "系統設定", url: "/settings", icon: Settings, roles: ["super_admin", "marketing_manager"] },
];

interface AppSidebarProps {
  userRole: string;
  systemName: string;
  logoUrl: string;
}

export function AppSidebar({ userRole, systemName, logoUrl }: AppSidebarProps) {
  const [location] = useLocation();
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const menuItems = allMenuItems.filter((item) => item.roles.includes(userRole));
  const { brands, selectedBrandId, setSelectedBrandId, selectedBrand, channels } = useBrand();

  const activeChannelCount = channels.filter(c => c.is_active).length;

  return (
    <aside className="w-[240px] min-w-[240px] bg-stone-800 text-white flex flex-col h-screen" data-testid="sidebar">
      <div className="p-5 border-b border-stone-700/50">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt="Logo" className="w-9 h-9 rounded-xl object-cover" data-testid="img-sidebar-logo" />
          ) : (
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-600">
              <Bot className="w-5 h-5 text-white" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate" data-testid="text-sidebar-title">{systemName}</h2>
            <p className="text-[11px] text-stone-400">多品牌全通路中控台</p>
          </div>
        </div>
      </div>

      <div className="px-3 pt-3 pb-1">
        <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2">品牌工作區</p>
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
                {selectedBrand?.name || "選擇品牌"}
              </p>
              <p className="text-[10px] text-stone-500 truncate">
                {activeChannelCount > 0 ? `${activeChannelCount} 個渠道` : "尚無渠道"}
              </p>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-stone-400 transition-transform ${brandMenuOpen ? "rotate-180" : ""}`} />
          </button>

          {brandMenuOpen && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-stone-700 rounded-xl border border-stone-600/50 shadow-xl overflow-hidden">
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

      <nav className="flex-1 p-3 space-y-1">
        <p className="text-[10px] font-medium text-stone-500 uppercase tracking-wider px-3 mb-2">功能選單</p>
        {menuItems.map((item) => {
          const isActive = item.url === "/" ? location === "/" : location.startsWith(item.url);
          return (
            <Link key={item.title} href={item.url} data-testid={`link-${item.url.replace("/", "") || "chat"}`}>
              <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all cursor-pointer ${
                isActive ? "bg-emerald-600/20 text-emerald-400" : "text-stone-300 hover:bg-stone-700/50 hover:text-white"
              }`}>
                <item.icon className="w-[18px] h-[18px] shrink-0" />
                <span className="flex-1 truncate">{item.title}</span>
                {isActive && <ChevronRight className="w-4 h-4 text-emerald-400" />}
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-stone-700/50">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${activeChannelCount > 0 ? "bg-emerald-400 animate-pulse" : "bg-stone-500"}`} />
          <span className="text-xs text-stone-400">
            {activeChannelCount > 0 ? `${activeChannelCount} 個渠道啟用中` : "尚未設定渠道"}
          </span>
        </div>
      </div>
    </aside>
  );
}
