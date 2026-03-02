import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Eye, EyeOff, Bot, UserCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/login", { username, password });
      const data = await res.json();
      if (data.success) {
        toast({ title: "登入成功", description: `歡迎回來，${data.user.display_name}！` });
        onLogin();
      }
    } catch (_e) {
      toast({ title: "登入失敗", description: "帳號或密碼錯誤，請重試", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#faf9f5] p-4">
      <div className="absolute inset-0 bg-gradient-to-br from-[#faf9f5] via-[#f5f0e8] to-[#ede8dc]" />
      <div className="relative w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-600 mb-5 shadow-lg shadow-emerald-600/20">
            <Bot className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-stone-800 tracking-tight" data-testid="text-login-title">全通路 AI 客服中控台</h1>
          <p className="text-stone-500 mt-2 text-sm">整合多渠道的智慧客服管理系統</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <Lock className="w-4 h-4 text-stone-400" />
            <span className="text-sm font-medium text-stone-600">系統登入</span>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <UserCircle className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <Input data-testid="input-username" type="text" placeholder="請輸入帳號" value={username} onChange={(e) => setUsername(e.target.value)} className="pl-10 bg-stone-50 border-stone-200 text-stone-800 placeholder:text-stone-400 focus:border-emerald-500 focus:ring-emerald-500/20" autoFocus />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <Input data-testid="input-password" type={showPassword ? "text" : "password"} placeholder="請輸入密碼" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-10 pr-10 bg-stone-50 border-stone-200 text-stone-800 placeholder:text-stone-400 focus:border-emerald-500 focus:ring-emerald-500/20" />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600" data-testid="button-toggle-password">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl" disabled={loading || !username.trim() || !password.trim()} data-testid="button-login">
              {loading ? "登入中..." : "登入系統"}
            </Button>
          </form>
          <div className="text-[11px] text-stone-400 text-center mt-4 space-y-0.5">
            <p>測試帳號：admin / admin123 (超級管理員)</p>
            <p>marketing / mkt123 (行銷經理) · agent / agent123 (客服人員)</p>
          </div>
        </div>
        <p className="text-center text-xs text-stone-400 mt-6">AI 客服管理平台 v4.0</p>
      </div>
    </div>
  );
}
