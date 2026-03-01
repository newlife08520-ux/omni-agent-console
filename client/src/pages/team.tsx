import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Users, Shield, Headphones, Mail, Plus, Trash2, UserPlus, Pencil } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { TeamMember } from "@shared/schema";

const ROLE_MAP: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  admin: { label: "管理員", color: "bg-violet-50 text-violet-600 border-violet-200", icon: Shield },
  agent: { label: "一般客服", color: "bg-sky-50 text-sky-600 border-sky-200", icon: Headphones },
};

export default function TeamPage() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [formName, setFormName] = useState("");
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formRole, setFormRole] = useState("agent");
  const [editName, setEditName] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState("agent");
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: members = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const avatarColors = ["bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-sky-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];
  const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];

  const handleCreate = async () => {
    if (!formName.trim() || !formUsername.trim() || !formPassword.trim()) {
      toast({ title: "請填寫所有欄位", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      await apiRequest("POST", "/api/team", {
        display_name: formName.trim(),
        username: formUsername.trim(),
        password: formPassword.trim(),
        role: formRole,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/team"] });
      toast({ title: "新增成功", description: `${formName} 已加入團隊` });
      setShowAddDialog(false);
      setFormName(""); setFormUsername(""); setFormPassword(""); setFormRole("agent");
    } catch (err: any) {
      const msg = err?.message?.includes("400") ? "該帳號已存在" : "新增失敗";
      toast({ title: msg, variant: "destructive" });
    } finally { setCreating(false); }
  };

  const handleOpenEdit = (member: TeamMember) => {
    setEditMember(member);
    setEditName(member.display_name);
    setEditPassword("");
    setEditRole(member.role);
    setShowEditDialog(true);
  };

  const handleUpdate = async () => {
    if (!editMember || !editName.trim()) {
      toast({ title: "姓名為必填", variant: "destructive" });
      return;
    }
    setUpdating(true);
    try {
      await apiRequest("PUT", `/api/team/${editMember.id}`, {
        display_name: editName.trim(),
        role: editRole,
        password: editPassword.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/team"] });
      toast({ title: "更新成功", description: `${editName} 的資料已更新` });
      setShowEditDialog(false);
      setEditMember(null);
    } catch {
      toast({ title: "更新失敗", variant: "destructive" });
    } finally { setUpdating(false); }
  };

  const handleDelete = async (id: number, name: string) => {
    try {
      await apiRequest("DELETE", `/api/team/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/team"] });
      toast({ title: "刪除成功", description: `${name} 已移出團隊` });
    } catch (err: any) {
      const msg = err?.message?.includes("400") ? "無法刪除目前登入的帳號" : "刪除失敗";
      toast({ title: msg, variant: "destructive" });
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><p className="text-stone-400">載入中...</p></div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="team-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-stone-800" data-testid="text-team-title">團隊管理</h1>
          <p className="text-sm text-stone-500 mt-1">管理客服團隊成員與權限設定</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-stone-500">共 {members.length} 位成員</div>
          <Button onClick={() => setShowAddDialog(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs" data-testid="button-add-member">
            <Plus className="w-3.5 h-3.5 mr-1.5" />新增成員
          </Button>
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
                <Avatar className="w-12 h-12 shrink-0">
                  <AvatarFallback className={`${getAvatarColor(member.id)} text-white font-semibold text-base`}>{member.display_name.charAt(0)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-800">{member.display_name}</span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${roleInfo.color}`}>
                      <RoleIcon className="w-3 h-3" />{roleInfo.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Mail className="w-3 h-3 text-stone-400" />
                    <span className="text-xs text-stone-500">@{member.username}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" onClick={() => handleOpenEdit(member)} data-testid={`button-edit-member-${member.id}`} className="text-stone-400 hover:text-emerald-600 hover:bg-emerald-50">
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => handleDelete(member.id, member.display_name)} data-testid={`button-delete-member-${member.id}`} className="text-red-400 hover:text-red-600 hover:bg-red-50">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="bg-white border-stone-200 rounded-2xl" data-testid="dialog-add-member">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-stone-800">
              <UserPlus className="w-5 h-5 text-emerald-600" />新增團隊成員
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">姓名</label>
              <Input data-testid="input-member-name" placeholder="輸入姓名" value={formName} onChange={(e) => setFormName(e.target.value)} className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">帳號 (Username)</label>
              <Input data-testid="input-member-username" placeholder="輸入帳號" value={formUsername} onChange={(e) => setFormUsername(e.target.value)} className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">密碼</label>
              <Input data-testid="input-member-password" type="password" placeholder="輸入密碼" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">角色</label>
              <Select value={formRole} onValueChange={setFormRole}>
                <SelectTrigger className="border-stone-200" data-testid="select-member-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin"><span className="flex items-center gap-1.5"><Shield className="w-3 h-3" />管理員 (Admin)</span></SelectItem>
                  <SelectItem value="agent"><span className="flex items-center gap-1.5"><Headphones className="w-3 h-3" />一般客服 (Agent)</span></SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddDialog(false)} className="text-stone-500">取消</Button>
            <Button onClick={handleCreate} disabled={creating} data-testid="button-confirm-add-member" className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {creating ? "建立中..." : "確認新增"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="bg-white border-stone-200 rounded-2xl" data-testid="dialog-edit-member">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-stone-800">
              <Pencil className="w-5 h-5 text-emerald-600" />編輯成員資料
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">帳號</label>
              <Input value={editMember?.username || ""} disabled className="bg-stone-100 border-stone-200 text-stone-400" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">姓名</label>
              <Input data-testid="input-edit-name" placeholder="輸入姓名" value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">新密碼 <span className="text-stone-400 font-normal">(留白代表不更改)</span></label>
              <Input data-testid="input-edit-password" type="password" placeholder="輸入新密碼 (選填)" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className="bg-stone-50 border-stone-200" />
            </div>
            <div>
              <label className="text-xs font-medium text-stone-600 mb-1 block">角色</label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger className="border-stone-200" data-testid="select-edit-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin"><span className="flex items-center gap-1.5"><Shield className="w-3 h-3" />管理員 (Admin)</span></SelectItem>
                  <SelectItem value="agent"><span className="flex items-center gap-1.5"><Headphones className="w-3 h-3" />一般客服 (Agent)</span></SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEditDialog(false)} className="text-stone-500">取消</Button>
            <Button onClick={handleUpdate} disabled={updating} data-testid="button-confirm-edit-member" className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {updating ? "更新中..." : "儲存變更"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
