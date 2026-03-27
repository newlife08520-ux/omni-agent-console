import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp,
  Inbox,
  Loader2,
  Clock,
  CheckCircle2,
  Target,
  Users,
  BarChart3,
  Tag,
  Headphones,
  AlertTriangle,
  PieChart as PieChartIcon,
} from "lucide-react";
import { getQueryFn } from "@/lib/queryClient";
import { useBrand } from "@/lib/brand-context";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

interface PerformanceStats {
  today_new: number;
  open_cases: number;
  processing: number;
  closed_today: number;
  closed_total: number;
  avg_first_reply_minutes: number | null;
  avg_close_minutes: number | null;
  close_rate: number | null;
  resolve_rate: number | null;
}

interface AgentPerformanceRow extends PerformanceStats {
  agent_id: number;
  display_name: string;
}

interface SupervisorReport {
  today_total: number;
  pending_count: number;
  transfer_count: number;
  lunch_pending_count: number;
  by_agent: { agent_id: number; display_name: string; today_assigned: number; open_cases: number; closed_today: number }[];
  tag_rank: { tag: string; count: number }[];
  category_ratio: { label: string; count: number }[];
}

interface ManagerDashboard {
  cards: {
    today_pending: number;
    urgent: number;
    unassigned: number;
    today_close_rate: number;
    closed_today: number;
    today_new: number;
  };
  status_distribution: { label: string; count: number }[];
  agent_workload: { id: number; name: string; open: number; max: number; pending: number }[];
  alerts: { type: string; count: number; threshold?: number }[];
  issue_type_rank: { name: string; count: number }[];
  tag_rank: { name: string; count: number }[];
}

function formatMinutes(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return `${Math.round(m)} 分鐘`;
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  return min ? `${h} 小時 ${min} 分` : `${h} 小時`;
}

function StatCard({ title, value, sub, icon: Icon, accent }: { title: string; value: string | number; sub?: string; icon: React.ElementType; accent?: "red" | "amber" | "emerald" }) {
  const accentCls = accent === "red" ? "text-red-600" : accent === "amber" ? "text-amber-600" : accent === "emerald" ? "text-emerald-600" : "text-stone-800";
  return (
    <Card className="border-stone-200 bg-white shadow-sm">
      <CardHeader className="pb-1 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-stone-500">{title}</CardTitle>
        <Icon className={`w-4 h-4 ${accent ? "opacity-80" : "text-stone-400"}`} />
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold ${accentCls}`}>{value}</p>
        {sub != null && <p className="text-xs text-stone-400 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

const CHART_COLORS = ["#10b981", "#f59e0b", "#6366f1", "#ec4899", "#8b5cf6", "#06b6d4", "#84cc16"];

export default function PerformancePage() {
  const { selectedBrandId } = useBrand();
  const { data: auth } = useQuery<{ user?: { role: string } }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const role = auth?.user?.role ?? "cs_agent";
  const isManager = role === "super_admin" || role === "marketing_manager";

  const { data: myStats, isLoading: myLoading } = useQuery<PerformanceStats>({
    queryKey: ["/api/performance/me"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: true,
  });

  const { data: allPerformance, isLoading: allLoading } = useQuery<AgentPerformanceRow[]>({
    queryKey: ["/api/performance"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: isManager,
  });

  const { data: report, isLoading: reportLoading } = useQuery<SupervisorReport>({
    queryKey: ["/api/supervisor/report"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: isManager,
  });

  const { data: dashboard, isLoading: dashboardLoading } = useQuery<ManagerDashboard>({
    queryKey: ["/api/manager-dashboard", selectedBrandId ?? "all"],
    queryFn: async () => {
      const url = selectedBrandId ? `/api/manager-dashboard?brand_id=${selectedBrandId}` : "/api/manager-dashboard";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    enabled: isManager,
  });

  if (myLoading && !isManager) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-stone-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>載入績效數據...</span>
      </div>
    );
  }

  const stats = isManager ? undefined : myStats;
  const cards = dashboard?.cards ?? {};
  const statusDist = dashboard?.status_distribution ?? [];
  const agentWorkload = dashboard?.agent_workload ?? [];
  const alerts = dashboard?.alerts ?? [];
  const issueRank = dashboard?.issue_type_rank ?? [];
  const tagRank = dashboard?.tag_rank ?? [];

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-6" data-testid="performance-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800">客服績效</h1>
        <p className="text-sm text-stone-500 mt-0.5">
          {isManager ? "戰情板：今日待處理、緊急案件、客服負載一目了然" : "您的今日工作量與解決率"}
        </p>
      </div>

      {!isManager && stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          <StatCard title="今日新進案件" value={stats.today_new} icon={Inbox} />
          <StatCard title="目前待處理" value={stats.open_cases} icon={Loader2} />
          <StatCard title="處理中" value={stats.processing} icon={Clock} />
          <StatCard title="今日已結案" value={stats.closed_today} icon={CheckCircle2} />
          <StatCard title="累計已結案" value={stats.closed_total} icon={Target} />
          <StatCard title="平均首次回覆" value={formatMinutes(stats.avg_first_reply_minutes)} icon={Clock} />
          <StatCard title="平均結案時間" value={formatMinutes(stats.avg_close_minutes)} icon={TrendingUp} />
          <StatCard
            title="結案率 / 解決率"
            value={stats.close_rate != null ? `${(stats.close_rate * 100).toFixed(1)}%` : "—"}
            sub="已結案／總接手"
            icon={Target}
          />
        </div>
      )}

      {isManager && (
        <Tabs defaultValue="dashboard" className="space-y-4">
          <TabsList className="bg-stone-100 p-1">
            <TabsTrigger value="dashboard">戰情板</TabsTrigger>
            <TabsTrigger value="performance">全部客服績效</TabsTrigger>
            <TabsTrigger value="report">主管報表</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-6">
            {dashboardLoading ? (
              <div className="flex items-center justify-center h-48 gap-2 text-stone-400">
                <Loader2 className="w-5 h-5 animate-spin" /> 載入戰情...
              </div>
            ) : (
              <>
                {/* 上方四張主卡 */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard title="今日待處理" value={cards.today_pending ?? 0} icon={Inbox} />
                  <StatCard title="緊急案件" value={cards.urgent ?? 0} icon={AlertTriangle} accent="red" />
                  <StatCard title="待分配" value={cards.unassigned ?? 0} icon={Users} accent="amber" />
                  <StatCard title="今日結案率" value={`${cards.today_close_rate ?? 0}%`} sub={`今日結案 ${cards.closed_today ?? 0} / 新進 ${cards.today_new ?? 0}`} icon={CheckCircle2} accent="emerald" />
                </div>

                {/* 異常／警示區 */}
                {alerts.length > 0 && (
                  <Card className="border-red-200 bg-red-50/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2 text-red-800">
                        <AlertTriangle className="w-4 h-4" /> 異常與警示
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-3">
                        {alerts.map((a) => (
                          <div key={a.type} className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 shadow-sm border border-red-100">
                            <span className="text-sm font-semibold text-red-700">{a.type}</span>
                            <span className="text-lg font-bold text-red-600">{a.count}</span>
                            {a.threshold != null && <span className="text-xs text-stone-500">（門檻 {a.threshold}）</span>}
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* 兩張圖表 */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <Card className="border-stone-200">
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <PieChartIcon className="w-4 h-4" /> 案件狀態分布
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {statusDist.length > 0 ? (
                        <div className="h-[240px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={statusDist}
                                dataKey="count"
                                nameKey="label"
                                cx="50%"
                                cy="50%"
                                innerRadius={60}
                                outerRadius={90}
                                paddingAngle={2}
                                label={({ label, percent }) => `${label} ${(percent * 100).toFixed(0)}%`}
                              >
                                {statusDist.map((_, i) => (
                                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(v: number) => [v, "件"]} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <p className="text-sm text-stone-400 py-8 text-center">尚無狀態數據</p>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-stone-200">
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" /> 各客服負載
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {agentWorkload.length > 0 ? (
                        <div className="h-[240px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={agentWorkload} layout="vertical" margin={{ left: 8, right: 8 }}>
                              <XAxis type="number" domain={[0, "auto"]} tickFormatter={(v) => `${v}`} />
                              <YAxis type="category" dataKey="name" width={72} tick={{ fontSize: 11 }} />
                              <Tooltip formatter={(v: number, name: string) => [v, name === "open" ? "未結案" : name === "pending" ? "待回覆" : "上限"]} />
                              <Bar dataKey="open" name="open" fill="#10b981" radius={[0, 4, 4, 0]} />
                              <Bar dataKey="pending" name="pending" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <p className="text-sm text-stone-400 py-8 text-center">尚無客服數據</p>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* 問題類型排行 + 熱門標籤 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card className="border-stone-200">
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" /> 問題類型排行
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {issueRank.length > 0 ? (
                        <ul className="space-y-2">
                          {issueRank.slice(0, 8).map((r, i) => (
                            <li key={r.name} className="flex items-center justify-between text-sm">
                              <span className="text-stone-700">{r.name}</span>
                              <span className="font-semibold text-stone-800">{r.count}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-stone-400">尚無數據</p>
                      )}
                    </CardContent>
                  </Card>
                  <Card className="border-stone-200">
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Tag className="w-4 h-4" /> 熱門標籤
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {tagRank.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {tagRank.slice(0, 12).map((t) => (
                            <Badge key={t.name} variant="secondary" className="text-xs">{t.name} ({t.count})</Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-stone-400">尚無標籤數據</p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            {allLoading ? (
              <div className="flex items-center justify-center h-48 gap-2 text-stone-400">
                <Loader2 className="w-5 h-5 animate-spin" /> 載入中...
              </div>
            ) : (
              <div className="space-y-4">
                {allPerformance?.map((row) => (
                  <Card key={row.agent_id} className="border-stone-200">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Headphones className="w-4 h-4 text-emerald-600" />
                        {row.display_name}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3 text-sm">
                        <div><span className="text-stone-500">今日新進</span><p className="font-semibold">{row.today_new}</p></div>
                        <div><span className="text-stone-500">待處理</span><p className="font-semibold">{row.open_cases}</p></div>
                        <div><span className="text-stone-500">處理中</span><p className="font-semibold">{row.processing}</p></div>
                        <div><span className="text-stone-500">今日結案</span><p className="font-semibold">{row.closed_today}</p></div>
                        <div><span className="text-stone-500">平均首次回覆</span><p className="font-semibold">{formatMinutes(row.avg_first_reply_minutes)}</p></div>
                        <div><span className="text-stone-500">解決率</span><p className="font-semibold">{row.resolve_rate != null ? `${(row.resolve_rate * 100).toFixed(0)}%` : "—"}</p></div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {(!allPerformance || allPerformance.length === 0) && (
                  <p className="text-stone-400 text-sm">尚無客服人員或無績效數據</p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="report" className="space-y-4">
            {reportLoading ? (
              <div className="flex items-center justify-center h-48 gap-2 text-stone-400">
                <Loader2 className="w-5 h-5 animate-spin" /> 載入報表...
              </div>
            ) : report ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <StatCard title="今日總案件數" value={report.today_total} icon={BarChart3} />
                  <StatCard title="待處理案件數" value={report.pending_count} icon={Inbox} />
                  <StatCard title="轉人工案件量" value={report.transfer_count} icon={Users} />
                  <StatCard title="午休待處理" value={report.lunch_pending_count} icon={Clock} />
                </div>
                <Card className="border-stone-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Users className="w-4 h-4" /> 各客服處理量（今日）
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {report.by_agent.map((a) => (
                        <Badge key={a.agent_id} variant="secondary" className="text-xs">
                          {a.display_name}：新分 {a.today_assigned} / 未結 {a.open_cases} / 已結 {a.closed_today}
                        </Badge>
                      ))}
                      {report.by_agent.length === 0 && <span className="text-stone-400 text-sm">尚無數據</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-stone-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Tag className="w-4 h-4" /> 常見問題標籤排行
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {report.tag_rank.map((t) => (
                        <Badge key={t.tag} variant="outline">{t.tag} ({t.count})</Badge>
                      ))}
                      {report.tag_rank.length === 0 && <span className="text-stone-400 text-sm">尚無標籤數據</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-stone-200">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="w-4 h-4" /> 問題類別占比
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {report.category_ratio.map((c) => (
                        <Badge key={c.label} variant="secondary">{c.label}：{c.count}</Badge>
                      ))}
                      {report.category_ratio.length === 0 && <span className="text-stone-400 text-sm">尚無數據</span>}
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
