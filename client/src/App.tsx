import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient, getQueryFn } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { BrandProvider } from "@/lib/brand-context";
import LoginPage from "@/pages/login";
import ChatPage from "@/pages/chat";
import SettingsPage from "@/pages/settings";
import KnowledgePage from "@/pages/knowledge";
import TeamPage from "@/pages/team";
import AnalyticsPage from "@/pages/analytics";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { LogOut, User, ShieldAlert } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Setting, UserRole, ROLE_LABELS } from "@shared/schema";

const ROLE_DISPLAY: Record<string, string> = {
  super_admin: "超級管理員",
  marketing_manager: "行銷經理",
  cs_agent: "客服人員",
};

const ROUTE_ACCESS: Record<string, string[]> = {
  "/": ["super_admin", "marketing_manager", "cs_agent"],
  "/settings": ["super_admin", "marketing_manager"],
  "/knowledge": ["super_admin", "marketing_manager"],
  "/team": ["super_admin"],
  "/analytics": ["super_admin", "marketing_manager"],
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

function GuardedRoute({ path, component: Component, userRole }: { path: string; component: React.ComponentType; userRole: string }) {
  const allowedRoles = ROUTE_ACCESS[path];
  if (allowedRoles && !allowedRoles.includes(userRole)) {
    return <Route path={path} component={AccessDenied} />;
  }
  return <Route path={path} component={Component} />;
}

interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
}

function AuthenticatedApp({ user }: { user: AuthUser }) {
  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] });
  };

  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const settingsMap: Record<string, string> = {};
  settings.forEach((s) => { settingsMap[s.key] = s.value; });

  return (
    <BrandProvider>
      <div className="flex h-screen w-full bg-[#faf9f5]">
        <AppSidebar
          userRole={user.role}
          systemName={settingsMap.system_name || "AI 客服中控台"}
          logoUrl={settingsMap.logo_url || ""}
        />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-end gap-3 px-5 py-2.5 border-b border-stone-200 bg-white/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <User className="w-3.5 h-3.5" />
              <span data-testid="text-current-user">{user.display_name}</span>
              <span className="px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 text-[10px] font-medium">
                {ROLE_DISPLAY[user.role] || user.role}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleLogout}
              data-testid="button-logout"
              className="text-xs text-stone-500 hover:text-stone-700 hover:bg-stone-100"
            >
              <LogOut className="w-3.5 h-3.5 mr-1.5" />
              登出
            </Button>
          </header>
          <main className="flex-1 overflow-auto">
            <Switch>
              <GuardedRoute path="/" component={ChatPage} userRole={user.role} />
              <GuardedRoute path="/settings" component={SettingsPage} userRole={user.role} />
              <GuardedRoute path="/knowledge" component={KnowledgePage} userRole={user.role} />
              <GuardedRoute path="/team" component={TeamPage} userRole={user.role} />
              <GuardedRoute path="/analytics" component={AnalyticsPage} userRole={user.role} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
    </BrandProvider>
  );
}

function AppContent() {
  const { data, isLoading } = useQuery<{ authenticated: boolean; user?: AuthUser }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    staleTime: 0,
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

  if (!data?.authenticated || !data?.user) {
    return <LoginPage onLogin={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] })} />;
  }

  return <AuthenticatedApp user={data.user} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
