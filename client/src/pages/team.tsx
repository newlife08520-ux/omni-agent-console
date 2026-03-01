import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Shield, Headphones, Circle, Mail } from "lucide-react";
import { getQueryFn } from "@/lib/queryClient";
import type { TeamMember } from "@shared/schema";

const ROLE_MAP: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  super_admin: { label: "超級管理員", color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400", icon: Shield },
  agent: { label: "一般客服", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", icon: Headphones },
};

export default function TeamPage() {
  const { data: members = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const avatarColors = ["bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500", "bg-rose-500", "bg-cyan-500", "bg-indigo-500"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-gray-400">載入中...</p></div>;
  }

  const onlineCount = members.filter((m) => m.status === "online").length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="team-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white" data-testid="text-team-title">團隊管理</h1>
          <p className="text-sm text-gray-500 mt-1">管理客服團隊成員與權限設定</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{onlineCount} 人在線</span>
          </div>
          <div className="text-sm text-gray-500">
            共 {members.length} 位成員
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-800 flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">團隊成員列表</span>
        </div>

        <div className="divide-y divide-gray-100 dark:divide-slate-800">
          {members.map((member) => {
            const roleInfo = ROLE_MAP[member.role] || ROLE_MAP.agent;
            const RoleIcon = roleInfo.icon;
            return (
              <div key={member.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors" data-testid={`team-member-${member.id}`}>
                <div className="relative shrink-0">
                  <Avatar className="w-12 h-12">
                    <AvatarFallback className={`${getAvatarColor(member.id)} text-white font-semibold text-base`}>
                      {member.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-slate-900 ${
                    member.status === "online" ? "bg-emerald-400" : "bg-gray-300 dark:bg-slate-600"
                  }`} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{member.name}</span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${roleInfo.color}`}>
                      <RoleIcon className="w-3 h-3" />
                      {roleInfo.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Mail className="w-3 h-3 text-gray-400" />
                    <span className="text-xs text-gray-500">{member.email}</span>
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-1.5">
                  <Circle className={`w-2 h-2 ${member.status === "online" ? "fill-emerald-500 text-emerald-500" : "fill-gray-300 text-gray-300"}`} />
                  <span className="text-xs text-gray-500">{member.status === "online" ? "在線" : "離線"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
