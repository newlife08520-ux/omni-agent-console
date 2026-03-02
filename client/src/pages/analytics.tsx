import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { TrendingUp, CheckCircle2, Users, Clock, Brain, Flame, Lightbulb, BarChart3, CalendarDays, ShieldCheck, ArrowRightLeft, Search, Tag, ShoppingBag, Monitor } from "lucide-react";
import { format } from "date-fns";
import { zhTW } from "date-fns/locale/zh-TW";
import type { AnalyticsData } from "@shared/schema";

const PIE_COLORS = ["#059669", "#d97706", "#7c3aed", "#0284c7", "#e11d48", "#ea580c", "#0d9488"];
const PLATFORM_COLORS = ["#06b6d4", "#8b5cf6"];
const ISSUE_TYPE_COLORS_CHART = ["#059669", "#d97706", "#7c3aed", "#0284c7", "#e11d48", "#ea580c", "#78716c"];

const RANGE_LABELS: Record<string, string> = {
  today: "今日",
  "7d": "近 7 天",
  "30d": "近 30 天",
  custom: "自訂區間",
};

export default function AnalyticsPage() {
  const [range, setRange] = useState("today");
  const [customStart, setCustomStart] = useState<Date | undefined>(undefined);
  const [customEnd, setCustomEnd] = useState<Date | undefined>(undefined);
  const [showStartCal, setShowStartCal] = useState(false);
  const [showEndCal, setShowEndCal] = useState(false);

  const queryParams = range === "custom" && customStart && customEnd
    ? `?range=custom&start=${format(customStart, "yyyy-MM-dd")}&end=${format(customEnd, "yyyy-MM-dd")}`
    : `?range=${range}`;

  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics", range, customStart?.toISOString(), customEnd?.toISOString()],
    queryFn: async () => {
      const res = await fetch(`/api/analytics${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  if (isLoading || !data) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入數據中...</p></div>;
  }

  const rangeLabel = range === "custom" && customStart && customEnd
    ? `${format(customStart, "M/d")} - ${format(customEnd, "M/d")}`
    : RANGE_LABELS[range] || "今日";

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" data-testid="analytics-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800" data-testid="text-analytics-title">數據戰情室</h1>
          <p className="text-sm text-stone-500 mt-1">即時監控客服績效與 AI 洞察分析</p>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-stone-400" />
          <Select value={range} onValueChange={(v) => { setRange(v); if (v !== "custom") { setCustomStart(undefined); setCustomEnd(undefined); } }}>
            <SelectTrigger className="w-[140px] h-9 text-sm border-stone-200 bg-white" data-testid="select-date-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">今日</SelectItem>
              <SelectItem value="7d">近 7 天</SelectItem>
              <SelectItem value="30d">近 30 天</SelectItem>
              <SelectItem value="custom">自訂區間</SelectItem>
            </SelectContent>
          </Select>

          {range === "custom" && (
            <div className="flex items-center gap-1.5">
              <Popover open={showStartCal} onOpenChange={setShowStartCal}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 text-xs border-stone-200 bg-white" data-testid="button-start-date">
                    {customStart ? format(customStart, "yyyy/MM/dd") : "起始日期"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customStart} onSelect={(d) => { setCustomStart(d); setShowStartCal(false); }} locale={zhTW} />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-stone-400">~</span>
              <Popover open={showEndCal} onOpenChange={setShowEndCal}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 text-xs border-stone-200 bg-white" data-testid="button-end-date">
                    {customEnd ? format(customEnd, "yyyy/MM/dd") : "結束日期"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customEnd} onSelect={(d) => { setCustomEnd(d); setShowEndCal(false); }} locale={zhTW} />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-inbound">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center"><TrendingUp className="w-5 h-5 text-emerald-600" /></div>
            <span className="text-xs font-medium text-stone-500">{rangeLabel}總進線量</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.todayInbound}</p>
          <p className="text-xs text-stone-400 mt-1">則訊息</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-completion">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-sky-100 flex items-center justify-center"><CheckCircle2 className="w-5 h-5 text-sky-600" /></div>
            <span className="text-xs font-medium text-stone-500">處理完成率</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.completionRate}%</p>
          <p className="text-xs text-stone-400 mt-1">已處理 {data.kpi.completedCount} 則</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-ai-rate">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center"><Users className="w-5 h-5 text-violet-600" /></div>
            <span className="text-xs font-medium text-stone-500">AI 攔截率</span>
          </div>
          <p className="text-3xl font-bold text-stone-800">{data.kpi.aiInterceptRate}%</p>
          <p className="text-xs text-stone-400 mt-1">AI 成功處理的對話比例</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-frt">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center"><Clock className="w-5 h-5 text-amber-600" /></div>
            <span className="text-xs font-medium text-stone-500">平均首次回覆時間</span>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-lg font-bold text-stone-800">AI {data.kpi.avgFrtAi}</p>
          </div>
          <p className="text-xs text-stone-400 mt-1">真人 {data.kpi.avgFrtHuman}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-ai-resolution">
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${(data.kpi.aiResolutionRate ?? 0) > 70 ? "bg-emerald-100" : "bg-stone-100"}`}>
              <ShieldCheck className={`w-5 h-5 ${(data.kpi.aiResolutionRate ?? 0) > 70 ? "text-emerald-600" : "text-stone-500"}`} />
            </div>
            <span className="text-xs font-medium text-stone-500">AI 解決率</span>
          </div>
          <p className={`text-3xl font-bold ${(data.kpi.aiResolutionRate ?? 0) > 70 ? "text-emerald-600" : "text-stone-800"}`} data-testid="text-ai-resolution-rate">{data.kpi.aiResolutionRate ?? 0}%</p>
          <p className="text-xs text-stone-400 mt-1">AI 自主解決問題的比例</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-transfer-rate">
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${(data.kpi.transferRate ?? 0) > 30 ? "bg-amber-100" : "bg-stone-100"}`}>
              <ArrowRightLeft className={`w-5 h-5 ${(data.kpi.transferRate ?? 0) > 30 ? "text-amber-600" : "text-stone-500"}`} />
            </div>
            <span className="text-xs font-medium text-stone-500">轉人工率</span>
          </div>
          <p className={`text-3xl font-bold ${(data.kpi.transferRate ?? 0) > 30 ? "text-amber-600" : "text-stone-800"}`} data-testid="text-transfer-rate">{data.kpi.transferRate ?? 0}%</p>
          <p className="text-xs text-stone-400 mt-1">需轉交人工處理的比例</p>
        </div>
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="kpi-order-query-success">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl bg-sky-100 flex items-center justify-center">
              <Search className="w-5 h-5 text-sky-600" />
            </div>
            <span className="text-xs font-medium text-stone-500">查單成功率</span>
          </div>
          <p className="text-3xl font-bold text-stone-800" data-testid="text-order-query-success-rate">{data.kpi.orderQuerySuccessRate ?? 0}%</p>
          <p className="text-xs text-stone-400 mt-1">訂單查詢成功的比例</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center"><BarChart3 className="w-4 h-4 text-emerald-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">{rangeLabel}績效比較</span>
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
                <Bar dataKey="cases" fill="#059669" radius={[8, 8, 0, 0]} name="解決案件數" animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center"><Brain className="w-4 h-4 text-violet-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">客戶進線意圖分佈</span>
              <p className="text-xs text-stone-500">{rangeLabel}各類型諮詢佔比</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-intent-distribution">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.intentDistribution} cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value" nameKey="name" animationDuration={800}>
                  {data.intentDistribution.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} formatter={(value: number) => [`${value}%`, "佔比"]} />
                <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={10} wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} formatter={(value: string) => <span className="text-stone-600">{value}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-rose-100 flex items-center justify-center"><Tag className="w-4 h-4 text-rose-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">問題類型分布</span>
              <p className="text-xs text-stone-500">{rangeLabel}各問題類型佔比</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-issue-type-distribution">
            {data.issueTypeDistribution && data.issueTypeDistribution.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.issueTypeDistribution} cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value" nameKey="name" animationDuration={800}>
                    {data.issueTypeDistribution.map((_entry, index) => (
                      <Cell key={`issue-${index}`} fill={ISSUE_TYPE_COLORS_CHART[index % ISSUE_TYPE_COLORS_CHART.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} formatter={(value: number) => [`${value}%`, "佔比"]} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={10} wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} formatter={(value: string) => <span className="text-stone-600">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full"><p className="text-sm text-stone-400">暫無數據</p></div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center"><ShoppingBag className="w-4 h-4 text-amber-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">訂單來源分布</span>
              <p className="text-xs text-stone-500">{rangeLabel}各訂單來源佔比</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-order-source-distribution">
            {data.orderSourceDistribution && data.orderSourceDistribution.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.orderSourceDistribution} cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value" nameKey="name" animationDuration={800}>
                    {data.orderSourceDistribution.map((_entry, index) => (
                      <Cell key={`source-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} formatter={(value: number) => [`${value}%`, "佔比"]} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={10} wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} formatter={(value: string) => <span className="text-stone-600">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full"><p className="text-sm text-stone-400">暫無數據</p></div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center"><ArrowRightLeft className="w-4 h-4 text-orange-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">轉人工原因排行</span>
              <p className="text-xs text-stone-500">{rangeLabel}主要轉人工處理原因</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-transfer-reasons">
            {data.transferReasons && data.transferReasons.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.transferReasons} layout="vertical" margin={{ top: 5, right: 30, left: 80, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                  <XAxis type="number" tick={{ fontSize: 12, fill: "#78716c" }} />
                  <YAxis type="category" dataKey="reason" tick={{ fontSize: 12, fill: "#78716c" }} width={75} />
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                  <Bar dataKey="count" fill="#ea580c" radius={[0, 8, 8, 0]} name="次數" animationDuration={800} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full"><p className="text-sm text-stone-400">暫無數據</p></div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-cyan-100 flex items-center justify-center"><Monitor className="w-4 h-4 text-cyan-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">平台來源分布</span>
              <p className="text-xs text-stone-500">{rangeLabel} LINE vs Messenger 佔比</p>
            </div>
          </div>
          <div className="h-[280px]" data-testid="chart-platform-distribution">
            {data.platformDistribution && data.platformDistribution.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.platformDistribution} cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value" nameKey="name" animationDuration={800}>
                    {data.platformDistribution.map((_entry, index) => (
                      <Cell key={`platform-${index}`} fill={PLATFORM_COLORS[index % PLATFORM_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} formatter={(value: number) => [`${value}%`, "佔比"]} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" iconSize={10} wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} formatter={(value: string) => <span className="text-stone-600">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full"><p className="text-sm text-stone-400">暫無數據</p></div>
            )}
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
