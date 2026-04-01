import type { IStorage } from "./storage";

export function getTransferUnavailableSystemMessage(
  storage: IStorage,
  reason: "weekend" | "lunch" | "after_hours" | "all_paused" | null
): string {
  const schedule = storage.getGlobalSchedule();
  if (reason === "weekend") return "目前為週末或非服務日，專人將於上班時間為您服務，請稍候。";
  if (reason === "lunch")
    return `目前為午休時段（${schedule.lunch_start_time}～${schedule.lunch_end_time}），專人將盡快為您服務。`;
  if (reason === "after_hours") return "目前為非服務時段，專人將於上班時間為您服務。";
  return "目前暫無法即時轉接專人，請稍後再試或留下訊息。";
}
