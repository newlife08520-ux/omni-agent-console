import { Link, useLocation } from "wouter";
import { MessageSquare, Settings, Brain, Bot, Users, ChevronRight, BarChart3 } from "lucide-react";

const allMenuItems = [
  { title: "即時客服", url: "/", icon: MessageSquare, roles: ["admin", "agent"] },
  { title: "AI 與知識庫", url: "/knowledge", icon: Brain, roles: ["admin", "agent"] },
  { title: "數據戰情室", url: "/analytics", icon: BarChart3, roles: ["admin"] },
  { title: "團隊管理", url: "/team", icon: Users, roles: ["admin"] },
  { title: "系統設定", url: "/settings", icon: Settings, roles: ["admin"] },
];

interface AppSidebarProps {
  userRole: "admin" | "agent";
  systemName: string;
  logoUrl: string;
}

export function AppSidebar({ userRole, systemName, logoUrl }: AppSidebarProps) {
  const [location] = useLocation();
  const menuItems = allMenuItems.filter((item) => item.roles.includes(userRole));

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
            <p className="text-[11px] text-stone-400">全通路管理平台</p>
          </div>
        </div>
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
          <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
          <span className="text-xs text-stone-400">LINE 渠道已啟用</span>
        </div>
      </div>
    </aside>
  );
}
