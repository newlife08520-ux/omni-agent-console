import { Switch, Route } from "wouter";
import { queryClient, getQueryFn } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import LoginPage from "@/pages/login";
import ChatPage from "@/pages/chat";
import SettingsPage from "@/pages/settings";
import KnowledgePage from "@/pages/knowledge";
import TeamPage from "@/pages/team";
import AnalyticsPage from "@/pages/analytics";
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { LogOut, User } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Setting } from "@shared/schema";

function Router() {
  return (
    <Switch>
      <Route path="/" component={ChatPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/knowledge" component={KnowledgePage} />
      <Route path="/team" component={TeamPage} />
      <Route path="/analytics" component={AnalyticsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "agent";
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
              {user.role === "admin" ? "管理員" : "客服人員"}
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
          <Router />
        </main>
      </div>
    </div>
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
