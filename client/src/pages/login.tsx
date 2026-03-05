import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Eye, EyeOff, UserCircle } from "lucide-react";
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
      const data = await res.json().catch(() => ({}));
      if (data?.success) {
        const name = data?.user?.display_name ?? data?.user?.username ?? "您";
        toast({ title: "登入成功", description: `歡迎回來，${name}！` });
        // 稍延再檢查登入狀態，確保瀏覽器已寫入 session cookie
        setTimeout(() => onLogin(), 150);
      } else {
        toast({ title: "登入失敗", description: data?.message ?? "帳號或密碼錯誤，請重試", variant: "destructive" });
      }
    } catch (_e) {
      toast({ title: "登入失敗", description: "帳號或密碼錯誤或連線失敗，請重試", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8f7f4] p-4">
      <div className="w-full max-w-[360px]">
        <div className="text-center mb-10">
          <h1 className="text-[1.5rem] font-semibold text-stone-800 tracking-tight" data-testid="text-login-title">
            全通路 AI 客服中控台
          </h1>
          <p className="text-stone-500 mt-1.5 text-[13px] tracking-wide">Omnichannel AI Agent Dashboard</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <UserCircle className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
            <Input
              data-testid="input-username"
              type="text"
              placeholder="帳號"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-11 pl-10 bg-white border-stone-200/80 text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:ring-1 focus:ring-stone-200 rounded-lg"
              autoFocus
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
            <Input
              data-testid="input-password"
              type={showPassword ? "text" : "password"}
              placeholder="密碼"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-11 pl-10 pr-10 bg-white border-stone-200/80 text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:ring-1 focus:ring-stone-200 rounded-lg"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
              data-testid="button-toggle-password"
              aria-label={showPassword ? "隱藏密碼" : "顯示密碼"}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <Button
            type="submit"
            className="w-full h-11 bg-stone-800 hover:bg-stone-700 text-white rounded-lg font-medium text-[13px] tracking-wide transition-colors"
            disabled={loading || !username.trim() || !password.trim()}
            data-testid="button-login"
          >
            {loading ? "登入中..." : "登入"}
          </Button>
        </form>
        <p className="text-center text-[11px] text-stone-400 mt-8 leading-relaxed">
          測試帳號：admin / admin123 · marketing / mkt123 · agent / agent123
        </p>
      </div>
    </div>
  );
}
