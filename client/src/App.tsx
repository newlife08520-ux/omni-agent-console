import React from "react";
import { Switch, Route, Link, useLocation } from "wouter";
import { queryClient, getQueryFn } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { BrandProvider } from "@/lib/brand-context";
import { ChatViewProvider } from "@/lib/chat-view-context";
import LoginPage from "@/pages/login";
import ChatPage from "@/pages/chat";
import CommentCenterPage from "./pages/comment-center";
import SettingsPage from "@/pages/settings";
import BrandsChannelsPage from "@/pages/brands-channels";
import KnowledgePage from "@/pages/knowledge";
import TeamPage from "@/pages/team";
import AnalyticsPage from "@/pages/analytics";
import PerformancePage from "@/pages/performance";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut, ShieldAlert, RefreshCw, Building2, Settings, Bell, Eye } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import type { Setting } from "@shared/schema";

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: unknown }
> {
  state = { hasError: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[AppErrorBoundary] 錯誤發生在 AppContent 子樹:", error);
    if (error instanceof Error) console.error("[AppErrorBoundary] stack:", error.stack);
    if (info?.componentStack) console.error("[AppErrorBoundary] componentStack:", info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const msg =
        this.state.error instanceof Error
          ? this.state.error.message
          : "頁面載入時發生問題，請重新整理再試。";
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#faf9f5] p-4">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50 flex items-center justify-center">
              <ShieldAlert className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-lg font-semibold text-stone-800">發生錯誤</h2>
            <p className="text-sm text-stone-500 mt-2">{msg}</p>
            <Button className="mt-6" onClick={() => window.location.reload()} data-testid="button-reload">
              <RefreshCw className="w-4 h-4 mr-2" />
              重新整理
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ROLE_DISPLAY: Record<string, string> = {
  super_admin: "超級管理員",
  marketing_manager: "行銷經理",
  cs_agent: "客服人員",
};

function AppHeader({
  systemName,
  logoUrl,
  onLogout,
  userRole,
}: {
  systemName: string;
  logoUrl: string;
  onLogout: () => void;
  userRole: string;
}) {
  const { selectedBrand, selectedBrandId } = useBrand();
  const title = selectedBrand?.name || systemName;
  const canSettings = userRole === "super_admin" || userRole === "marketing_manager";
  const isManager = userRole === "super_admin" || userRole === "marketing_manager";
  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30000,
  });
  const unreadCount = unreadData?.count ?? 0;
  const { data: managerStats } = useQuery<{ urgent: number; unassigned: number }>({
    queryKey: ["/api/manager-stats", selectedBrandId ?? "all"],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/manager-stats?brand_id=${selectedBrandId}` : "/api/manager-stats";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    enabled: isManager,
    refetchInterval: 15000,
  });
  return (
    <header className="flex items-center justify-between gap-4 px-5 py-3 border-b border-stone-200 bg-white/95 backdrop-blur-sm shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="w-9 h-9 rounded-xl object-cover shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded-xl bg-stone-700 flex items-center justify-center shrink-0">
            <Building2 className="w-5 h-5 text-white" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-stone-800 truncate" data-testid="text-header-title">{title}</h1>
          <p className="text-[11px] text-stone-500 truncate">{selectedBrand ? "品牌工作區" : "全通路中控台"}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="inline-flex items-center gap-1 text-[11px] text-stone-500">
          <Eye className="w-3.5 h-3.5" />
          {userRole === "cs_agent" ? "客服" : "主管"}
        </span>
        {isManager && (managerStats?.urgent != null || managerStats?.unassigned != null) && (
          <span className="inline-flex items-center gap-2 text-[11px]">
            <span className="text-red-600 font-medium">緊急 {managerStats?.urgent ?? 0}</span>
            <span className="text-stone-400">|</span>
            <span className="text-amber-600 font-medium">待分配 {managerStats?.unassigned ?? 0}</span>
          </span>
        )}
        <Link href="/">
          <span className="inline-flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-700 px-2 py-1.5 rounded-md hover:bg-stone-100 cursor-pointer relative">
            <Bell className="w-3.5 h-3.5" />
            通知
            {unreadCount > 0 && (
              <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
        </Link>
        {canSettings && (
          <Link href="/settings">
            <span className="inline-flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-700 px-2 py-1.5 rounded-md hover:bg-stone-100 cursor-pointer">
              <Settings className="w-3.5 h-3.5" />設定
            </span>
          </Link>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onLogout}
          data-testid="button-logout"
          className="text-xs text-stone-500 hover:text-stone-700 hover:bg-stone-100"
        >
          <LogOut className="w-3.5 h-3.5 mr-1.5" />
          登出
        </Button>
      </div>
    </header>
  );
}

const ROUTE_ACCESS: Record<string, string[]> = {
  "/": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/:tab": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/inbox": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/rules": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/channel-binding": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/simulate": ["super_admin", "marketing_manager", "cs_agent"],
  "/comment-center/batch-pages": ["super_admin"],
  "/settings": ["super_admin", "marketing_manager"],
  "/settings/brands-channels": ["super_admin", "marketing_manager"],
  "/knowledge": ["super_admin", "marketing_manager"],
  "/team": ["super_admin", "marketing_manager"],
  "/analytics": ["super_admin", "marketing_manager"],
  "/performance": ["super_admin", "marketing_manager", "cs_agent"],
};

function AccessDenied() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50 flex items-center justify-center">
          <ShieldAlert className="w-8 h-8 text-red-400" />
        </div>
        <h3 className="text-lg font-semibold text-stone-600">權限不足</h3>
        <p className="text-sm text-stone-400 mt-1">您沒有權限存取此頁面</p>
      </div>
    </div>
  );
}

/** P0-A: /comment-center 無 segment 或帶舊 hash 時導向新 path（client 端） */
function CommentCenterRedirect() {
  const [, setLocation] = useLocation();
  React.useEffect(() => {
    const h = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") || "";
    const map: Record<string, string> = {
      "page-settings": "/comment-center/channel-binding",
      "risk-rules": "/comment-center/rules",
      "rules": "/comment-center/rules",
      "mapping": "/comment-center/rules",
      "simulate": "/comment-center/simulate",
      "inbox": "/comment-center/inbox",
    };
    const target = map[h] || "/comment-center/inbox";
    setLocation(target);
  }, [setLocation]);
  return null;
}

function GuardedRoute({ path, component: Component, userRole }: { path: string; component: React.ComponentType; userRole: string }) {
  const allowedRoles = ROUTE_ACCESS[path];
  if (allowedRoles && !allowedRoles.includes(userRole)) {
    return <Route path={path} component={AccessDenied} />;
  }
  if (Component == null) {
    console.error("[GuardedRoute] component is null/undefined for path:", path);
    return <Route path={path} component={NotFound} />;
  }
  return <Route path={path} component={Component} />;
}

interface AuthUser {
  id: number;
  username?: string;
  display_name?: string;
  role: string;
}

function AuthenticatedApp({ user }: { user: AuthUser }) {
  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] });
  };

  const { data: settingsData } = useQuery<Setting[] | null>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const settings = Array.isArray(settingsData) ? settingsData : [];
  const settingsMap: Record<string, string> = {};
  settings.filter((s): s is { key: string; value: string } => s != null && typeof s === "object" && "key" in s && "value" in s).forEach((s) => { settingsMap[s.key] = s.value; });

  return (
    <BrandProvider>
      <ChatViewProvider>
        <AuthenticatedAppErrorBoundary>
        <div className="flex h-screen w-full bg-[#faf9f5]">
          <AppSidebar
          user={user}
          userRole={user.role}
          systemName={settingsMap.system_name || "AI 客服中控台"}
          logoUrl={settingsMap.logo_url || ""}
        />
        <div className="flex flex-col flex-1 min-w-0">
          <AppHeader
            systemName={settingsMap.system_name || "AI 客服中控台"}
            logoUrl={settingsMap.logo_url || ""}
            onLogout={handleLogout}
            userRole={user.role}
          />
          <main className="flex-1 overflow-auto">
            <Switch>
              <GuardedRoute path="/" component={ChatPage} userRole={user.role} />
              <GuardedRoute path="/comment-center" component={CommentCenterRedirect} userRole={user.role} />
              <GuardedRoute path="/comment-center/:tab" component={CommentCenterPage} userRole={user.role} />
              <GuardedRoute path="/settings/brands-channels" component={BrandsChannelsPage} userRole={user.role} />
              <GuardedRoute path="/settings" component={SettingsPage} userRole={user.role} />
              <GuardedRoute path="/knowledge" component={KnowledgePage} userRole={user.role} />
              <GuardedRoute path="/team" component={TeamPage} userRole={user.role} />
              <GuardedRoute path="/analytics" component={AnalyticsPage} userRole={user.role} />
              <GuardedRoute path="/performance" component={PerformancePage} userRole={user.role} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
        </AuthenticatedAppErrorBoundary>
      </ChatViewProvider>
    </BrandProvider>
  );
}

/** 包住登入後主畫面，用於定位白屏是否發生在此子樹（sidebar / main / Route） */
class AuthenticatedAppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: unknown }
> {
  state = { hasError: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[AuthenticatedAppErrorBoundary] 錯誤發生在登入後主畫面（sidebar/main/Route）:", error);
    if (info?.componentStack) console.error("[AuthenticatedAppErrorBoundary] componentStack:", info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#faf9f5] p-4">
          <div className="text-center max-w-md">
            <h2 className="text-lg font-semibold text-red-600">主畫面載入錯誤</h2>
            <p className="text-sm text-stone-500 mt-2">{msg}</p>
            <Button className="mt-4" onClick={() => window.location.reload()} data-testid="button-reload-auth">
              重新整理
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const { data, isLoading, isError } = useQuery<{ authenticated?: boolean; user?: AuthUser } | null>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    staleTime: 0,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf9f5]">
        <div className="flex items-center gap-2 text-stone-400">
          <div className="w-5 h-5 border-2 border-stone-300 border-t-emerald-500 rounded-full animate-spin" />
          <span className="text-sm">載入中...</span>
        </div>
      </div>
    );
  }

  if (isError || data == null) {
    return <LoginPage onLogin={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] })} />;
  }

  if (!data.authenticated || !data.user) {
    return <LoginPage onLogin={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] })} />;
  }

  const user = data.user;
  if (user == null || typeof user !== "object" || !user.role) {
    console.error("[AppContent] data.user 異常，無法渲染 AuthenticatedApp:", user);
    return <LoginPage onLogin={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] })} />;
  }
  return <AuthenticatedApp user={user} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppErrorBoundary>
          <AppContent />
        </AppErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
