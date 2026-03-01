import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Shield, Headphones, Circle, Mail } from "lucide-react";
import { getQueryFn } from "@/lib/queryClient";
import type { TeamMember } from "@shared/schema";

const ROLE_MAP: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  super_admin: { label: "超級管理員", color: "bg-violet-50 text-violet-600 border-violet-200", icon: Shield },
  agent: { label: "一般客服", color: "bg-sky-50 text-sky-600 border-sky-200", icon: Headphones },
};

export default function TeamPage() {
  const { data: members = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const avatarColors = ["bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-sky-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入中...</p></div>;
  }

  const onlineCount = members.filter((m) => m.status === "online").length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="team-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-stone-800" data-testid="text-team-title">團隊管理</h1>
          <p className="text-sm text-stone-500 mt-1">管理客服團隊成員與權限設定</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-stone-500">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{onlineCount} 人在線</span>
          </div>
          <div className="text-sm text-stone-500">共 {members.length} 位成員</div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center gap-2">
          <Users className="w-4 h-4 text-stone-400" />
          <span className="text-sm font-semibold text-stone-800">團隊成員列表</span>
        </div>

        <div className="divide-y divide-stone-100">
          {members.map((member) => {
            const roleInfo = ROLE_MAP[member.role] || ROLE_MAP.agent;
            const RoleIcon = roleInfo.icon;
            return (
              <div key={member.id} className="flex items-center gap-4 px-5 py-4 hover:bg-stone-50 transition-colors" data-testid={`team-member-${member.id}`}>
                <div className="relative shrink-0">
                  <Avatar className="w-12 h-12">
                    <AvatarFallback className={`${getAvatarColor(member.id)} text-white font-semibold text-base`}>{member.name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-white ${member.status === "online" ? "bg-emerald-400" : "bg-stone-300"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-800">{member.name}</span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${roleInfo.color}`}>
                      <RoleIcon className="w-3 h-3" />{roleInfo.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Mail className="w-3 h-3 text-stone-400" /><span className="text-xs text-stone-500">{member.email}</span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <Circle className={`w-2 h-2 ${member.status === "online" ? "fill-emerald-500 text-emerald-500" : "fill-stone-300 text-stone-300"}`} />
                  <span className="text-xs text-stone-500">{member.status === "online" ? "在線" : "離線"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
