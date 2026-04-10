// === 營業時間設定 ===
// 預設：週一~週五 09:00~18:00 (Asia/Taipei)
// 可用環境變數覆寫，未來可移到 brand 設定

export const BUSINESS_HOURS = {
  workDays: process.env.BUSINESS_WORK_DAYS
    ? process.env.BUSINESS_WORK_DAYS.split(",").map((s) => parseInt(s.trim(), 10))
    : [1, 2, 3, 4, 5], // 0=Sunday, 1=Monday, ..., 6=Saturday
  startHour: parseInt(process.env.BUSINESS_START_HOUR ?? "9", 10),
  endHour: parseInt(process.env.BUSINESS_END_HOUR ?? "18", 10),
  timezone: process.env.BUSINESS_TIMEZONE ?? "Asia/Taipei",
};

const WEEKDAY_SHORT_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * 取得指定 Date 在目標時區的曆法與鐘面時分（用於營業判斷）
 */
export function getTaipeiComponents(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_HOURS.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";

  let hour = parseInt(get("hour"), 10);
  if (Number.isNaN(hour)) hour = 0;
  if (hour === 24) hour = 0;

  const wk = get("weekday");
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    dayOfWeek: WEEKDAY_SHORT_TO_NUM[wk] ?? 1,
    hour,
    minute: parseInt(get("minute"), 10) || 0,
  };
}

/**
 * 將「台北牆上時間」轉成對應的 UTC Date（台北無夏令時間，固定 UTC+8）
 */
export function taipeiWallToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function addCalendarDaysTaipei(
  year: number,
  month: number,
  day: number,
  daysToAdd: number,
): { year: number; month: number; day: number; dayOfWeek: number } {
  const noon = taipeiWallToUtcDate(year, month, day, 12, 0, 0);
  const shifted = new Date(noon.getTime() + daysToAdd * 86400000);
  const p = getTaipeiComponents(shifted);
  return { year: p.year, month: p.month, day: p.day, dayOfWeek: p.dayOfWeek };
}

/**
 * 判斷某個時間點是否在營業時間內（含起始整點、不含結束整點：9:00–17:59 為營業）
 */
export function isWithinBusinessHours(date: Date): boolean {
  const { dayOfWeek, hour } = getTaipeiComponents(date);
  const isWorkDay = BUSINESS_HOURS.workDays.includes(dayOfWeek);
  const isWorkHour = hour >= BUSINESS_HOURS.startHour && hour < BUSINESS_HOURS.endHour;
  return isWorkDay && isWorkHour;
}

/**
 * 給定一個時間點：
 * - 若已在營業時間內 → 回傳該時刻（新 Date 複本）
 * - 否則 → 下一個「營業日 startHour:00」的瞬間（台北牆上時間）
 */
export function findNextBusinessMoment(from: Date): Date {
  if (isWithinBusinessHours(from)) {
    return new Date(from.getTime());
  }

  const { startHour, workDays } = BUSINESS_HOURS;
  const fp = getTaipeiComponents(from);

  for (let add = 0; add < 14; add++) {
    const { year: y, month: m, day: d, dayOfWeek } = addCalendarDaysTaipei(fp.year, fp.month, fp.day, add);
    if (!workDays.includes(dayOfWeek)) continue;

    const open = taipeiWallToUtcDate(y, m, d, startHour, 0, 0);
    if (open.getTime() >= from.getTime()) {
      return open;
    }
  }

  console.warn("[business-hours] findNextBusinessMoment 超過 14 天仍無結果，回傳 from+14d");
  return new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
}
