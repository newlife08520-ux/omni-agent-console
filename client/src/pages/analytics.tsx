import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, CheckCircle2, Users, Brain, Flame, Lightbulb, CalendarDays,
  ShieldCheck, ArrowRightLeft, Search, Package, Monitor, Activity, ShieldAlert,
  Copy, Lock, PackageX, Timer, ArrowRight, MessageSquare, Headphones,
  AlertTriangle, ThumbsDown, Info, BarChart3,
} from "lucide-react";
import { format } from "date-fns";
import { zhTW } from "date-fns/locale/zh-TW";
import type { AnalyticsData } from "@shared/schema";
import { useBrand } from "@/lib/brand-context";

const PIE_COLORS = ["#059669", "#d97706", "#7c3aed", "#0284c7", "#e11d48", "#ea580c", "#0d9488", "#64748b"];
const AREA_COLORS = { user: "#0284c7", ai: "#059669", admin: "#d97706" };

const RANGE_LABELS: Record<string, string> = {
  today: "今日",
  "7d": "近 7 天",
  "30d": "近 30 天",
  custom: "自訂區間",
};

const renderPieLabel = ({ name, value, percent }: any) => {
  if (percent < 0.03) return null;
  return `${name} ${value}（${(percent * 100).toFixed(1)}%）`;
};

export default function AnalyticsPage() {
  const { selectedBrandId, selectedBrand } = useBrand();
  const [range, setRange] = useState("30d");
  const [customStart, setCustomStart] = useState<Date | undefined>(undefined);
  const [customEnd, setCustomEnd] = useState<Date | undefined>(undefined);
  const [showStartCal, setShowStartCal] = useState(false);
  const [showEndCal, setShowEndCal] = useState(false);

  const brandQs = selectedBrandId != null ? `&brand_id=${selectedBrandId}` : "";
  const queryParams =
    (range === "custom" && customStart && customEnd
      ? `?range=custom&start=${format(customStart, "yyyy-MM-dd")}&end=${format(customEnd, "yyyy-MM-dd")}`
      : `?range=${range}`) + brandQs;

  const { data, isLoading, isError, error, refetch } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics", range, customStart?.toISOString(), customEnd?.toISOString(), selectedBrandId ?? "all"],
    queryFn: async () => {
      const res = await fetch(`/api/analytics${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const { data: healthData } = useQuery<{
    webhookSigFails: number;
    dedupeHits: number;
    lockTimeouts: number;
    orderLookupFails: number;
    timeoutEscalations: number;
    totalAlerts: number;
    transferReasonTop5: { reason: string; count: number }[];
    alertsByType: { type: string; count: number }[];
  }>({
    queryKey: ["/api/analytics/health", range, customStart?.toISOString(), customEnd?.toISOString()],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/health${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6" data-testid="analytics-error">
        <p className="text-stone-600 text-center">數據戰情室載入失敗（{(error as Error)?.message || "錯誤"}）。請確認已以主管／管理員身分登入，或稍後再試。</p>
        <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
          重新載入
        </Button>
      </div>
    );
  }

  if (isLoading || !data) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入數據中...</p></div>;
  }

  const rangeLabel = range === "custom" && customStart && customEnd
    ? `${format(customStart, "M/d")} - ${format(customEnd, "M/d")}`
    : RANGE_LABELS[range] || "今日";

  const kpi = data.kpi;

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-5" data-testid="analytics-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800" data-testid="text-analytics-title">數據戰情室</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            即時監控客服績效（僅顯示真實數據）
            <span className="mx-1.5 text-stone-300">|</span>
            品牌：
            <span className="text-stone-700 font-medium">
              {selectedBrandId == null ? "全部" : (selectedBrand?.name ?? `ID ${selectedBrandId}`)}
            </span>
            <span className="mx-1.5 text-stone-300">|</span>
            區間：<span className="text-stone-700 font-medium">{rangeLabel}</span>
            <span className="block text-xs text-stone-400 mt-1">與留言中心相同，請用左側選單切換品牌；選「全部」時不分品牌匯總。</span>
          </p>
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

      <div className="grid grid-cols-3 gap-3">
        <KpiCard icon={<MessageSquare className="w-5 h-5 text-emerald-600" />} bg="bg-emerald-100"
          label={`${rangeLabel}客戶進線`} value={kpi.customerMessages} unit="則客戶訊息"
          sub="sender_type = user" testId="kpi-inbound" />
        <KpiCard icon={<Users className="w-5 h-5 text-sky-600" />} bg="bg-sky-100"
          label="活躍對話" value={kpi.activeContacts} unit="位客戶有互動"
          sub="有客戶訊息的 contact 數" testId="kpi-active" />
        <KpiCard icon={<CheckCircle2 className="w-5 h-5 text-violet-600" />} bg="bg-violet-100"
          label="處理完成率" value={kpi.completionRate !== null ? `${kpi.completionRate}%` : null}
          nullLabel="暫無資料" sub={kpi.completionRate !== null ? `已解決 ${kpi.resolvedCount} / 活躍 ${kpi.activeContacts}` : "活躍對話數為 0"}
          testId="kpi-completion" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <KpiCard icon={<Headphones className="w-5 h-5 text-amber-600" />} bg="bg-amber-100"
          label="轉人工率" value={kpi.transferRate !== null ? `${kpi.transferRate}%` : null}
          nullLabel={kpi.activeContacts === 0 ? "暫無資料" : "0"}
          sub={kpi.transferRate !== null ? `${kpi.transferCount} / ${kpi.activeContacts} 位` : "本期間無人工升級"}
          testId="kpi-transfer-rate"
          highlight={kpi.transferRate !== null && kpi.transferRate > 15 ? "text-amber-600" : undefined} />
        <KpiCard icon={<ShieldCheck className="w-5 h-5 text-emerald-600" />} bg="bg-emerald-100"
          label="AI 解決率" value={kpi.aiHasData && kpi.aiResolutionRate !== null ? `${kpi.aiResolutionRate}%` : null}
          nullLabel="尚未啟用"
          sub={kpi.aiHasData ? "AI 處理且 resolved / AI 介入的對話" : "本期間無 AI 處理紀錄"}
          testId="kpi-ai-resolution" />
        <KpiCard icon={<Search className="w-5 h-5 text-sky-600" />} bg="bg-sky-100"
          label="查單成功率" value={kpi.orderQueryHasData && kpi.orderQuerySuccessRate !== null ? `${kpi.orderQuerySuccessRate}%` : null}
          nullLabel="暫無資料"
          sub={kpi.orderQueryHasData ? "成功查到 / 發起查單數" : "本期間無查單紀錄"}
          testId="kpi-order-query" />
      </div>

      {data.dailyVolume.length > 1 && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-sky-100 flex items-center justify-center"><TrendingUp className="w-4 h-4 text-sky-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">每日訊息量趨勢</span>
              <p className="text-xs text-stone-500">依日期查看客戶、AI、真人訊息量</p>
            </div>
          </div>
          <div className="h-[240px]" data-testid="chart-daily-volume">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.dailyVolume} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#78716c" }} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: "#78716c" }} />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }}
                  labelFormatter={(v: string) => `日期：${v}`} />
                <Area type="monotone" dataKey="user" name="客戶" stroke={AREA_COLORS.user} fill={AREA_COLORS.user} fillOpacity={0.15} strokeWidth={2} />
                <Area type="monotone" dataKey="ai" name="AI 回覆" stroke={AREA_COLORS.ai} fill={AREA_COLORS.ai} fillOpacity={0.15} strokeWidth={2} />
                <Area type="monotone" dataKey="admin" name="真人回覆" stroke={AREA_COLORS.admin} fill={AREA_COLORS.admin} fillOpacity={0.15} strokeWidth={2} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: "12px" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <ChartCard icon={<BarChart3 className="w-4 h-4 text-emerald-600" />} bg="bg-emerald-100" title="訊息類型分布" sub={`${rangeLabel}各角色訊息量`} testId="chart-message-split">
          {data.messageSplit.some(m => m.value > 0) ? (
            <div className="h-full flex flex-col">
              <div className="flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={data.messageSplit} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name" label={renderPieLabel} animationDuration={800}>
                      {data.messageSplit.map((_e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }}
                      formatter={(value: number, _n: string, props: any) => [`${value}（${props.payload.pct}%）`, props.payload.name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                {data.messageSplit.map((m, i) => (
                  <span key={i} className="text-xs text-stone-600 flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PIE_COLORS[i] }} />
                    {m.name} {m.value}（{m.pct}%）
                  </span>
                ))}
              </div>
            </div>
          ) : <EmptyState msg="目前期間無訊息資料" />}
        </ChartCard>

        <ChartCard icon={<Brain className="w-4 h-4 text-violet-600" />} bg="bg-violet-100" title="客戶進線意圖" sub={data.intentDistribution.some(d => d.isEstimate) ? "⚠ 暫時推估（關鍵字分析）" : `${rangeLabel}各類型分布`} testId="chart-intent-distribution">
          {data.intentDistribution.length > 0 ? (
            <div className="h-full flex flex-col">
              {data.intentDistribution.length <= 4 ? (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.intentDistribution} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name" label={renderPieLabel} animationDuration={800}>
                        {data.intentDistribution.map((_e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.intentDistribution} layout="vertical" margin={{ top: 5, right: 20, left: 70, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                      <XAxis type="number" tick={{ fontSize: 10, fill: "#78716c" }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#78716c" }} width={65} />
                      <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                      <Bar dataKey="value" fill="#7c3aed" radius={[0, 6, 6, 0]} name="筆數" animationDuration={800} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {data.intentUnclassifiedPct > 0 && (
                <p className="text-xs text-amber-600 text-center mt-1 flex items-center justify-center gap-1">
                  <Info className="w-3 h-3" /> 仍有 {data.intentUnclassifiedPct}% 對話尚未完成分類
                </p>
              )}
            </div>
          ) : <EmptyState msg="目前期間無意圖分類資料" />}
        </ChartCard>

        <ChartCard icon={<Monitor className="w-4 h-4 text-cyan-600" />} bg="bg-cyan-100" title="對話狀態分布" sub={`${rangeLabel}活躍對話當前狀態`} testId="chart-status-distribution">
          {data.statusDistribution.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.statusDistribution} layout="vertical" margin={{ top: 5, right: 20, left: 60, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                <XAxis type="number" tick={{ fontSize: 10, fill: "#78716c" }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#78716c" }} width={55} />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }}
                  formatter={(value: number) => [`${value} 位`, "對話數"]} />
                <Bar dataKey="value" fill="#7c3aed" radius={[0, 6, 6, 0]} name="對話數" animationDuration={800}>
                  {data.statusDistribution.map((_e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState msg="目前期間無活躍對話" />}
        </ChartCard>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <ChartCard icon={<BarChart3 className="w-4 h-4 text-rose-600" />} bg="bg-rose-100" title="問題類型分布" sub={`${rangeLabel}已分類問題`} testId="chart-issue-type">
          {data.issueTypeDistribution.length > 0 ? (
            <div className="h-full flex flex-col">
              {data.issueTypeDistribution.length <= 4 ? (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.issueTypeDistribution} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name" label={renderPieLabel} animationDuration={800}>
                        {data.issueTypeDistribution.map((_e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }}
                        formatter={(value: number) => [`${value} 筆`, "數量"]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.issueTypeDistribution} layout="vertical" margin={{ top: 5, right: 20, left: 60, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                      <XAxis type="number" tick={{ fontSize: 10, fill: "#78716c" }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#78716c" }} width={55} />
                      <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                      <Bar dataKey="value" fill="#e11d48" radius={[0, 6, 6, 0]} name="筆數" animationDuration={800} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                {data.issueTypeDistribution.map((d, i) => (
                  <span key={i} className="text-xs text-stone-600 flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PIE_COLORS[i] }} />
                    {d.name} {d.value}
                  </span>
                ))}
              </div>
            </div>
          ) : <EmptyState msg="目前期間尚無完成分類的問題類型資料" />}
        </ChartCard>

        <ChartCard icon={<ArrowRightLeft className="w-4 h-4 text-orange-600" />} bg="bg-orange-100" title="轉人工原因排行" sub={`${rangeLabel}轉人工原因`} testId="chart-transfer-reasons">
          {data.transferReasons.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.transferReasons} layout="vertical" margin={{ top: 5, right: 30, left: 80, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                <XAxis type="number" tick={{ fontSize: 11, fill: "#78716c" }} />
                <YAxis type="category" dataKey="reason" tick={{ fontSize: 10, fill: "#78716c" }} width={75} />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }} />
                <Bar dataKey="count" fill="#ea580c" radius={[0, 6, 6, 0]} name="次數" animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState msg="本期間無轉人工紀錄" />}
        </ChartCard>

        <ChartCard icon={<Monitor className="w-4 h-4 text-cyan-600" />} bg="bg-cyan-100" title="平台來源分布" sub={`${rangeLabel} LINE vs Messenger`} testId="chart-platform">
          {data.platformDistribution.length > 0 ? (
            <div className="h-full flex flex-col">
              <div className="flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={data.platformDistribution} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value" nameKey="name" label={renderPieLabel} animationDuration={800}>
                      {data.platformDistribution.map((_e, i) => <Cell key={i} fill={["#06b6d4", "#8b5cf6"][i % 2]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e7e5e4", fontSize: "13px" }}
                      formatter={(value: number) => [`${value} 位`, "客戶數"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                {data.platformDistribution.map((d, i) => (
                  <span key={i} className="text-xs text-stone-600 flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: ["#06b6d4", "#8b5cf6"][i % 2] }} />
                    {d.name} {d.value}
                  </span>
                ))}
              </div>
            </div>
          ) : <EmptyState msg="目前期間無平台資料" />}
        </ChartCard>
      </div>

      {data.topKeywords.length > 0 && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center"><Search className="w-4 h-4 text-indigo-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">熱門關鍵字排行</span>
              <p className="text-xs text-stone-500">客戶訊息中最常出現的關鍵字</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2" data-testid="section-top-keywords">
            {data.topKeywords.map((kw, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full border border-stone-200 bg-stone-50 text-stone-700"
                data-testid={`keyword-${i}`}>
                <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                {kw.keyword}
                <span className="text-xs text-stone-400 ml-0.5">({kw.count})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-8 h-8 rounded-xl bg-sky-100 flex items-center justify-center"><Brain className="w-4 h-4 text-sky-600" /></div>
          <div>
            <span className="text-sm font-semibold text-stone-800">AI 智慧營運報告</span>
            <p className="text-xs text-stone-500">根據{rangeLabel}真實數據門檻自動判讀（非模板句）</p>
          </div>
        </div>

        {(data.aiInsights.hotProducts.length > 0 || data.aiInsights.customerConcerns.length > 0) && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            {data.aiInsights.hotProducts.length > 0 && (
              <div className="bg-amber-50/60 rounded-xl border border-amber-100 p-4" data-testid="section-hot-products">
                <div className="flex items-center gap-2 mb-3">
                  <Package className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-semibold text-amber-800">熱門詢問商品</span>
                </div>
                <div className="space-y-2">
                  {data.aiInsights.hotProducts.map((p, i) => (
                    <div key={i} className="flex items-center justify-between" data-testid={`hot-product-${i}`}>
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-700 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                        <span className="text-sm text-stone-700">{p.name}</span>
                      </div>
                      <span className="text-xs text-stone-500 bg-amber-100 px-2 py-0.5 rounded-full">{p.mentions} 次提及</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.aiInsights.customerConcerns.length > 0 && (
              <div className="bg-rose-50/60 rounded-xl border border-rose-100 p-4" data-testid="section-customer-concerns">
                <div className="flex items-center gap-2 mb-3">
                  <ThumbsDown className="w-4 h-4 text-rose-500" />
                  <span className="text-sm font-semibold text-rose-800">客戶在意的點</span>
                </div>
                <div className="space-y-2">
                  {data.aiInsights.customerConcerns.map((c, i) => (
                    <div key={i} className="flex items-center justify-between" data-testid={`concern-${i}`}>
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-rose-200 text-rose-700 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                        <span className="text-sm text-stone-700">{c.concern}</span>
                      </div>
                      <span className="text-xs text-stone-500 bg-rose-100 px-2 py-0.5 rounded-full">{c.count} 次</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-red-50/50 rounded-xl border border-red-100 p-4" data-testid="section-pain-points">
            <div className="flex items-center gap-2 mb-3">
              <Flame className="w-4 h-4 text-red-500" />
              <span className="text-sm font-semibold text-red-700">痛點與風險</span>
            </div>
            {data.aiInsights.painPoints.length > 0 ? (
              <div className="space-y-2.5">
                {data.aiInsights.painPoints.map((point, i) => (
                  <div key={i} className="flex gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-stone-700 leading-relaxed">{point}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-400">目前未觀察到明顯異常風險</p>
            )}
          </div>
          <div className="bg-emerald-50/50 rounded-xl border border-emerald-100 p-4" data-testid="section-suggestions">
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb className="w-4 h-4 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-700">營運優化建議</span>
            </div>
            {data.aiInsights.suggestions.length > 0 ? (
              <div className="space-y-2.5">
                {data.aiInsights.suggestions.map((suggestion, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-xs flex items-center justify-center font-semibold">{i + 1}</span>
                    <p className="text-sm text-stone-700 leading-relaxed">{suggestion}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-400">目前無具體建議，持續監控中</p>
            )}
          </div>
        </div>
      </div>

      {healthData && (
        <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm" data-testid="section-system-health">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-rose-100 flex items-center justify-center"><Activity className="w-4 h-4 text-rose-600" /></div>
            <div>
              <span className="text-sm font-semibold text-stone-800">系統健康監控</span>
              <p className="text-xs text-stone-500">Webhook 安全、重複攔截、超時與轉接統計</p>
            </div>
            {healthData.totalAlerts === 0 && (
              <span className="ml-auto text-xs text-emerald-600 font-medium bg-emerald-50 px-2.5 py-1 rounded-full" data-testid="text-health-ok">一切正常</span>
            )}
          </div>
          <div className="grid grid-cols-5 gap-3 mb-4">
            <HealthCard icon={<ShieldAlert className="w-4 h-4 text-red-400" />} value={healthData.webhookSigFails} label="簽章失敗" testId="health-sig-fails" />
            <HealthCard icon={<Copy className="w-4 h-4 text-amber-400" />} value={healthData.dedupeHits} label="重複攔截" testId="health-dedupe-hits" />
            <HealthCard icon={<Lock className="w-4 h-4 text-violet-400" />} value={healthData.lockTimeouts} label="鎖逾時" testId="health-lock-timeouts" />
            <HealthCard icon={<PackageX className="w-4 h-4 text-orange-400" />} value={healthData.orderLookupFails} label="查單失敗" testId="health-order-fails" />
            <HealthCard icon={<Timer className="w-4 h-4 text-sky-400" />} value={healthData.timeoutEscalations} label="超時升級" testId="health-timeout-escalations" />
          </div>
          {healthData.transferReasonTop5.length > 0 && (
            <div className="bg-stone-50/50 rounded-xl border border-stone-100 p-4" data-testid="section-transfer-reasons-health">
              <div className="flex items-center gap-2 mb-3">
                <ArrowRight className="w-4 h-4 text-stone-500" />
                <span className="text-xs font-semibold text-stone-700">轉接原因 Top 5</span>
              </div>
              <div className="space-y-2">
                {healthData.transferReasonTop5.map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm" data-testid={`transfer-reason-health-${i}`}>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-stone-200 text-stone-600 text-xs flex items-center justify-center font-medium">{i + 1}</span>
                      <span className="text-stone-700">{item.reason}</span>
                    </div>
                    <span className="text-xs font-medium text-stone-500 bg-stone-100 px-2 py-0.5 rounded-full">{item.count} 次</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KpiCard({ icon, bg, label, value, unit, sub, testId, highlight, nullLabel }: {
  icon: React.ReactNode; bg: string; label: string; value: number | string | null; unit?: string; sub?: string; testId: string; highlight?: string; nullLabel?: string;
}) {
  const isNull = value === null;
  return (
    <div className="bg-white rounded-2xl border border-stone-200 p-4 shadow-sm" data-testid={testId}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-9 h-9 rounded-xl ${bg} flex items-center justify-center`}>{icon}</div>
        <span className="text-xs font-medium text-stone-500">{label}</span>
      </div>
      {isNull ? (
        <p className="text-lg font-semibold text-stone-300">{nullLabel || "暫無資料"}</p>
      ) : (
        <p className={`text-2xl font-bold ${highlight || "text-stone-800"}`}>{value}</p>
      )}
      {unit && !isNull && <p className="text-xs text-stone-400 mt-0.5">{unit}</p>}
      {sub && <p className="text-[11px] text-stone-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function ChartCard({ icon, bg, title, sub, testId, children }: {
  icon: React.ReactNode; bg: string; title: string; sub: string; testId: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-8 h-8 rounded-xl ${bg} flex items-center justify-center`}>{icon}</div>
        <div>
          <span className="text-sm font-semibold text-stone-800">{title}</span>
          <p className="text-xs text-stone-500">{sub}</p>
        </div>
      </div>
      <div className="h-[240px]" data-testid={testId}>{children}</div>
    </div>
  );
}

function HealthCard({ icon, value, label, testId }: { icon: React.ReactNode; value: number; label: string; testId: string }) {
  const isAlert = value > 0;
  return (
    <div className={`rounded-xl border p-3 text-center ${isAlert ? "border-amber-200 bg-amber-50/50" : "border-stone-100"}`} data-testid={testId}>
      <div className="flex items-center justify-center mb-1">{icon}</div>
      <p className={`text-xl font-bold ${isAlert ? "text-amber-600" : "text-stone-800"}`}>{value}</p>
      <p className="text-xs text-stone-500 mt-0.5">{label}</p>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <Info className="w-6 h-6 text-stone-300 mx-auto mb-2" />
        <p className="text-sm text-stone-400">{msg}</p>
      </div>
    </div>
  );
}
