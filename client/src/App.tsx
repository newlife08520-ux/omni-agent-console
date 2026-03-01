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
import NotFound from "@/pages/not-found";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

function Router() {
  return (
    <Switch>
      <Route path="/" component={ChatPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/knowledge" component={KnowledgePage} />
      <Route path="/team" component={TeamPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] });
  };

  return (
    <div className="flex h-screen w-full bg-gray-50 dark:bg-slate-950">
      <AppSidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <header className="flex items-center justify-end px-5 py-2.5 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleLogout}
            data-testid="button-logout"
            className="text-xs text-gray-500 hover:text-gray-700"
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
  const { data, isLoading } = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    staleTime: 0,
  });

  const authenticated = data?.authenticated === true;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="flex items-center gap-2 text-slate-400">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm">載入中...</span>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={() => queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] })} />;
  }

  return <AuthenticatedApp />;
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
