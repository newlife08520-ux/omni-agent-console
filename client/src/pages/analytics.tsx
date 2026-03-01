import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { TrendingUp, Users, Star, Brain, Flame, Lightbulb, BarChart3 } from "lucide-react";
import type { AnalyticsData } from "@shared/schema";

const PIE_COLORS = ["#059669", "#d97706", "#7c3aed", "#0284c7"];

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  if (isLoading || !data) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入數據中...</p></div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" data-testid="analytics-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800" data-testid="text-analytics-title">數據戰情室</h1>
        <p className="text-sm text-stone-500 mt-1">即時監控客服績效與 AI 洞察分析</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-inbound">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center"><TrendingUp className="w-5 h-5 text-emerald-600" /></div>
            <span className="text-xs font-medium text-stone-500">今日總進線量</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.todayInbound}</p>
          <p className="text-xs text-stone-400 mt-1">相較昨日 +12%</p>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-ai-rate">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center"><Users className="w-5 h-5 text-violet-600" /></div>
            <span className="text-xs font-medium text-stone-500">AI 攔截率</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.aiInterceptRate}%</p>
          <p className="text-xs text-stone-400 mt-1">AI 成功處理的對話比例</p>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-csat">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center"><Star className="w-5 h-5 text-amber-600" /></div>
            <span className="text-xs font-medium text-stone-500">客戶滿意度 CSAT</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.csatScore} <span className="text-lg">/ 5</span></p>
          <p className="text-xs text-stone-400 mt-1">本週平均評分</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><BarChart3 className="w-4 h-4 text-emerald-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">本週績效比較</span>
              <p className="text-xs text-stone-500">各客服專員解決案件數量</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-agent-performance">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.agentPerformance} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#78716c" }} />
                <YAxis tick={{ fontSize: 12, fill: "#78716c" }} />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                <Bar dataKey="cases" fill="#059669" radius={[8, 8, 0, 0]} name="解決案件數" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center"><Brain className="w-4 h-4 text-violet-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">客戶進線意圖分佈</span>
              <p className="text-xs text-stone-500">本週各類型諮詢佔比</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-intent-distribution">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.intentDistribution} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={4} dataKey="value" nameKey="name" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                  {data.intentDistribution.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                <Legend wrapperStyle={{ fontSize: "12px" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-8 h-8 rounded-xl bg-sky-100 flex items-center justify-center"><Brain className="w-4 h-4 text-sky-600" /></div>
          <div>
            <span className="text-sm font-semibold text-stone-800">AI 顧客語意分析報告</span>
            <p className="text-xs text-stone-500">由 AI 自動彙總本週客戶對話趨勢</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-5">
          <div className="bg-red-50/50 rounded-2xl border border-red-100 p-4" data-testid="section-pain-points">
            <div className="flex items-center gap-2 mb-3">
              <Flame className="w-4 h-4 text-red-500" />
              <span className="text-sm font-semibold text-red-700">本週三大客訴痛點</span>
            </div>
            <div className="space-y-3">
              {data.aiInsights.painPoints.map((point, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-red-100 text-red-600 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                  <p className="text-sm text-stone-700 leading-relaxed">{point}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-emerald-50/50 rounded-2xl border border-emerald-100 p-4" data-testid="section-suggestions">
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb className="w-4 h-4 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-700">營運優化建議</span>
            </div>
            <div className="space-y-3">
              {data.aiInsights.suggestions.map((suggestion, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                  <p className="text-sm text-stone-700 leading-relaxed">{suggestion}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
