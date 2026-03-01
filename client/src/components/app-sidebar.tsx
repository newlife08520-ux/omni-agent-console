import { Link, useLocation } from "wouter";
import { MessageSquare, Settings, Brain, Bot, Users, ChevronRight } from "lucide-react";

const menuItems = [
  { title: "即時客服", url: "/", icon: MessageSquare },
  { title: "AI 與知識庫", url: "/knowledge", icon: Brain },
  { title: "團隊管理", url: "/team", icon: Users },
  { title: "系統設定", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <aside className="w-[240px] min-w-[240px] bg-slate-900 text-white flex flex-col h-screen" data-testid="sidebar">
      <div className="p-5 border-b border-slate-700/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate" data-testid="text-sidebar-title">AI 客服中控台</h2>
            <p className="text-[11px] text-slate-400">全通路管理平台</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider px-3 mb-2">功能選單</p>
        {menuItems.map((item) => {
          const isActive = item.url === "/" ? location === "/" : location.startsWith(item.url);
          return (
            <Link
              key={item.title}
              href={item.url}
              data-testid={`link-${item.url.replace("/", "") || "chat"}`}
            >
              <div
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all cursor-pointer ${
                  isActive
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                <item.icon className="w-[18px] h-[18px] shrink-0" />
                <span className="flex-1 truncate">{item.title}</span>
                {isActive && <ChevronRight className="w-4 h-4 text-blue-400" />}
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-700/50">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
          <span className="text-xs text-slate-400">LINE 渠道已啟用</span>
        </div>
      </div>
    </aside>
  );
}
