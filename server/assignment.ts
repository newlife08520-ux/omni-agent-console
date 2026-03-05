/**
 * 人工客服案件分配邏輯
 * 條件：is_online、is_available、工作時段內、非午休、auto_assign_enabled、未超過 max_active_conversations
 * 策略：負載最少 → 最久未分配
 */
import { storage } from "./storage";
import type { AgentStatus } from "@shared/schema";

const OPEN_STATUSES = ["new_case", "pending", "pending_info", "pending_order_id", "awaiting_human", "assigned", "processing", "waiting_customer", "resolved_observe", "reopened", "high_risk"];

const SCHEDULE_TIMEZONE = "Asia/Taipei";

function parseTimeToMinutes(t: string): number {
  const [h, m] = (t || "00:00").split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 取得「目前」在客服時區的時分（分鐘數），用於比對上班/午休/下班（設定為台灣時間） */
function getNowMinutesInScheduleTz(): number {
  const s = new Date().toLocaleString("sv-SE", { timeZone: SCHEDULE_TIMEZONE });
  const part = s.slice(11, 16);
  const [h, m] = part.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 單一客服是否在上班時段內（台灣時區、未午休、on_duty） */
export function isAgentInWork(agentId: number): boolean {
  const global = storage.getGlobalSchedule();
  const status = storage.getAgentStatus(agentId);
  const nowMinutes = getNowMinutesInScheduleTz();
  const startStr = status?.work_start_time ?? global.work_start_time;
  const endStr = status?.work_end_time ?? global.work_end_time;
  const start = parseTimeToMinutes(startStr);
  const end = parseTimeToMinutes(endStr);
  if (status?.on_duty === 0) return false;
  const lunchStart = parseTimeToMinutes(status?.lunch_start_time ?? global.lunch_start_time);
  const lunchEnd = parseTimeToMinutes(status?.lunch_end_time ?? global.lunch_end_time);
  if (nowMinutes >= lunchStart && nowMinutes < lunchEnd) return false;
  return nowMinutes >= start && nowMinutes < end;
}

/** 取得可接案的客服（在線、可分配、時段內、未超負載），依「目前處理量最少」優先，再今日分配數 */
export function getEligibleAgents(): { agentId: number; priority: number; openCases: number; todayAssigned: number }[] {
  storage.resetAgentDailyCountsIfNewDay();
  const global = storage.getGlobalSchedule();
  const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
  const list: { agentId: number; priority: number; openCases: number; todayAssigned: number }[] = [];
  const nowMinutes = getNowMinutesInScheduleTz();

  const isInLunch = (a: AgentStatus | undefined) => {
    const startStr = a?.lunch_start_time || global.lunch_start_time;
    const endStr = a?.lunch_end_time || global.lunch_end_time;
    const start = parseTimeToMinutes(startStr);
    const end = parseTimeToMinutes(endStr);
    return nowMinutes >= start && nowMinutes < end;
  };
  const isInWork = (a: AgentStatus | undefined) => {
    const startStr = a?.work_start_time || global.work_start_time;
    const endStr = a?.work_end_time || global.work_end_time;
    const start = parseTimeToMinutes(startStr);
    const end = parseTimeToMinutes(endStr);
    return nowMinutes >= start && nowMinutes < end;
  };

  for (const m of members) {
    if (m.is_online !== 1 || m.is_available !== 1) continue;
    const status = storage.getAgentStatus(m.id);
    if (status?.lunch_break === 1 || status?.on_duty === 0 || status?.pause_new_cases === 1) continue;
    if (status?.auto_assign_enabled === 0) continue;
    if (isInLunch(status) || !isInWork(status)) continue;
    const openCases = m.open_cases_count ?? storage.getOpenCasesCountForAgent(m.id);
    const maxActive = status?.max_active_conversations ?? m.max_active_conversations ?? 10;
    if (openCases >= maxActive) continue;
    const todayAssigned = status?.today_assigned_count ?? 0;
    list.push({
      agentId: m.id,
      priority: status?.priority ?? 1,
      openCases,
      todayAssigned,
    });
  }

  list.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.openCases !== b.openCases) return a.openCases - b.openCases;
    if (a.todayAssigned !== b.todayAssigned) return a.todayAssigned - b.todayAssigned;
    return 0;
  });
  return list;
}

/** 是否全員都在午休或不可接案（用於顯示「暫時忙碌中」） */
export function isAllAgentsUnavailable(): boolean {
  return getEligibleAgents().length === 0 && storage.getTeamMembers().filter((m) => m.role === "cs_agent").length > 0;
}

/** 從可接案名單中選下一位（同順位時已按負載排好，取第一個） */
export function getNextAgent(): number | null {
  const eligible = getEligibleAgents();
  return eligible.length > 0 ? eligible[0].agentId : null;
}

/** 自動分配案件給下一位客服；回傳被指派的 agent id，若無人可派則 null */
export function assignCase(contactId: number): number | null {
  if (!storage.getAssignmentAutoEnabled()) return null;
  const agentId = getNextAgent();
  if (agentId == null) return null;
  const contact = storage.getContact(contactId);
  if (!contact) return null;
  const now = new Date();
  const nowStr = now.toISOString().replace("T", " ").substring(0, 19);
  const firstAssignedAt = contact.first_assigned_at || nowStr;
  const slaMin = storage.getSlaMinutes();
  const slaDeadline = new Date(now.getTime() + slaMin * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
  storage.createAssignmentRecord(contactId, agentId, null, null, "自動分配", "auto_assign", null);
  storage.updateContactAssignment(contactId, agentId, firstAssignedAt, "auto", 0, null, slaDeadline);
  storage.updateContactStatus(contactId, "assigned");
  storage.updateContactAssignmentStatus(contactId, "assigned");
  storage.incrementAgentTodayAssigned(agentId);
  syncAgentOpenCases(agentId);
  return agentId;
}

/** 手動指派：指定案件派給某位客服（管理員/主管） */
export function assignCaseManual(contactId: number, agentId: number, byAgentId: number, reason?: string | null): boolean {
  const contact = storage.getContact(contactId);
  if (!contact) return false;
  const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
  const target = members.find((m) => m.id === agentId);
  if (!target) return false;
  const openCases = target.open_cases_count ?? storage.getOpenCasesCountForAgent(agentId);
  const maxActive = target.max_active_conversations ?? 10;
  if (openCases >= maxActive) return false;
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const firstAssignedAt = contact.first_assigned_at || now;
  const slaMin = storage.getSlaMinutes();
  const slaDeadline = new Date(Date.now() + slaMin * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
  storage.createAssignmentRecord(contactId, agentId, byAgentId, null, reason ?? "手動指派", "manual_assign", byAgentId);
  storage.updateContactAssignment(contactId, agentId, firstAssignedAt, "manual", 0, reason ?? null, slaDeadline);
  storage.updateContactStatus(contactId, "assigned");
  storage.updateContactAssignmentStatus(contactId, "assigned");
  storage.incrementAgentTodayAssigned(agentId);
  syncAgentOpenCases(agentId);
  return true;
}

/** 手動改派：主管/客服將案件改派給另一客服 */
export function reassignCase(contactId: number, newAgentId: number, byAgentId: number, note: string | null): boolean {
  const contact = storage.getContact(contactId);
  if (!contact) return false;
  const prevAgentId = contact.assigned_agent_id;
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const slaMin = storage.getSlaMinutes();
  const slaDeadline = new Date(Date.now() + slaMin * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
  storage.createAssignmentRecord(contactId, newAgentId, byAgentId, prevAgentId ?? null, note ?? "手動改派", "manual_assign", byAgentId);
  storage.updateContactAssignment(contactId, newAgentId, undefined, "reassign", undefined, undefined, slaDeadline);
  storage.updateContactStatus(contactId, "assigned");
  storage.updateContactAssignmentStatus(contactId, "reassigned");
  storage.incrementContactReassignCount(contactId);
  storage.incrementAgentTodayAssigned(newAgentId);
  if (prevAgentId != null) syncAgentOpenCases(prevAgentId);
  syncAgentOpenCases(newAgentId);
  return true;
}

/** 移回待分配：取消指派，案件回到待人工佇列 */
export function unassignCase(contactId: number, _byAgentId: number): boolean {
  const contact = storage.getContact(contactId);
  if (!contact) return false;
  const prevAgentId = contact.assigned_agent_id;
  storage.updateContactAssignment(contactId, null, undefined, undefined, 1);
  storage.updateContactStatus(contactId, "awaiting_human");
  storage.updateContactAssignmentStatus(contactId, "waiting_human");
  if (prevAgentId != null) syncAgentOpenCases(prevAgentId);
  return true;
}

/** 結案：更新案件狀態並扣該客服未結案數 */
export function closeCase(contactId: number, closedByAgentId: number): void {
  storage.updateContactClosed(contactId, closedByAgentId);
  syncAgentOpenCases(closedByAgentId);
}

/** 無人可接時的原因：午休中 / 已下班 / 全員暫停（供 AI 顯示不同提示） */
export function getUnavailableReason(): "lunch" | "after_hours" | "all_paused" | null {
  const members = storage.getTeamMembers().filter((m) => m.role === "cs_agent");
  if (members.length === 0) return null;
  const global = storage.getGlobalSchedule();
  const nowMinutes = getNowMinutesInScheduleTz();
  const workEnd = parseTimeToMinutes(global.work_end_time);
  const lunchStart = parseTimeToMinutes(global.lunch_start_time);
  const lunchEnd = parseTimeToMinutes(global.lunch_end_time);
  if (nowMinutes >= workEnd) return "after_hours";
  if (nowMinutes >= lunchStart && nowMinutes < lunchEnd) {
    const anyInLunch = members.some((m) => {
      const status = storage.getAgentStatus(m.id);
      const start = parseTimeToMinutes(status?.lunch_start_time || global.lunch_start_time);
      const end = parseTimeToMinutes(status?.lunch_end_time || global.lunch_end_time);
      return nowMinutes >= start && nowMinutes < end;
    });
    if (anyInLunch && getEligibleAgents().length === 0) return "lunch";
  }
  if (getEligibleAgents().length === 0) return "all_paused";
  return null;
}

/** 逾時未回覆：若已分配但超過 SLA 無人回覆，嘗試重新分配給其他在線客服 */
export function tryReassignOverdue(contactId: number): { reassigned: boolean; newAgentId?: number; reason?: string } {
  if (!storage.getAssignmentTimeoutReassignEnabled()) return { reassigned: false };
  const contact = storage.getContact(contactId);
  if (!contact?.assigned_agent_id) return { reassigned: false };
  if (!["assigned", "processing", "waiting_customer"].includes(contact.status)) return { reassigned: false };
  const slaMin = storage.getSlaMinutes();
  const now = new Date();
  const refTime = contact.last_human_reply_at || contact.assigned_at || contact.first_assigned_at;
  if (!refTime) return { reassigned: false };
  const ref = new Date(refTime);
  const elapsed = (now.getTime() - ref.getTime()) / 60000;
  if (elapsed < slaMin) return { reassigned: false };
  const next = getNextAgent();
  if (next == null || next === contact.assigned_agent_id) return { reassigned: false };
  const prev = contact.assigned_agent_id;
  const note = `逾時 ${slaMin} 分鐘未回覆，自動重分配`;
  storage.createAssignmentRecord(contactId, next, null, prev, note, "reassign_timeout", null);
  const nowStr = now.toISOString().replace("T", " ").substring(0, 19);
  const slaDeadline = new Date(now.getTime() + slaMin * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);
  storage.updateContactAssignment(contactId, next, undefined, "reassign", undefined, undefined, slaDeadline);
  storage.updateContactStatus(contactId, "assigned");
  storage.updateContactAssignmentStatus(contactId, "reassigned");
  storage.incrementContactReassignCount(contactId);
  storage.incrementAgentTodayAssigned(next);
  syncAgentOpenCases(prev);
  syncAgentOpenCases(next);
  return { reassigned: true, newAgentId: next, reason: `逾時${slaMin}分鐘未回覆` };
}

/** 掃描所有已分配案件，逾時者嘗試重分配（可由定時或 API 觸發） */
export function runOverdueReassign(): { contactId: number; reassigned: boolean }[] {
  if (!storage.getAssignmentTimeoutReassignEnabled()) return [];
  const slaMin = storage.getSlaMinutes();
  const contacts = storage.getContacts();
  const results: { contactId: number; reassigned: boolean }[] = [];
  for (const c of contacts) {
    if (!c.assigned_agent_id || !["assigned", "processing", "waiting_customer"].includes(c.status)) continue;
    const refTime = c.last_human_reply_at || (c as any).assigned_at || c.first_assigned_at;
    if (!refTime) continue;
    const elapsed = (Date.now() - new Date(refTime).getTime()) / 60000;
    if (elapsed >= slaMin) {
      const r = tryReassignOverdue(c.id);
      results.push({ contactId: c.id, reassigned: r.reassigned });
    }
  }
  return results;
}

/** 將 agent_status.open_cases_count 同步為實際未結案數 */
export function syncAgentOpenCases(agentId: number): void {
  const count = storage.getOpenCasesCountForAgent(agentId);
  const status = storage.getAgentStatus(agentId);
  if (status) {
    storage.upsertAgentStatus({ user_id: agentId, open_cases_count: count });
  }
}
