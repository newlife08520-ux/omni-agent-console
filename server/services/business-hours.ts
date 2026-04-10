import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// === 營業時間設定 ===
export const BUSINESS_HOURS = {
  workDays: process.env.BUSINESS_WORK_DAYS
    ? process.env.BUSINESS_WORK_DAYS.split(",").map((s) => parseInt(s.trim(), 10))
    : [1, 2, 3, 4, 5], // 0=Sunday, 1=Monday, ..., 6=Saturday
  startHour: parseInt(process.env.BUSINESS_START_HOUR ?? "9", 10),
  endHour: parseInt(process.env.BUSINESS_END_HOUR ?? "18", 10),
  timezone: process.env.BUSINESS_TIMEZONE ?? "Asia/Taipei",
};

// === 國定假日載入 ===
interface HolidayEntry {
  date: string;
  name: string;
}

interface HolidayFile {
  year: number;
  holidays: HolidayEntry[];
}

const HOLIDAY_DATES = new Set<string>();
const HOLIDAY_NAMES = new Map<string, string>();

function resolveHolidaysDir(): string {
  const fromCwd = path.join(process.cwd(), "server", "data", "holidays");
  if (fs.existsSync(fromCwd)) return fromCwd;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "..", "data", "holidays");
}

function loadHolidays(): void {
  const holidaysDir = resolveHolidaysDir();

  try {
    if (!fs.existsSync(holidaysDir)) {
      console.warn("[business-hours] holidays directory not found:", holidaysDir);
      return;
    }

    const files = fs.readdirSync(holidaysDir).filter((f) => f.endsWith(".json"));
    let totalLoaded = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(holidaysDir, file), "utf-8");
        const data = JSON.parse(content) as HolidayFile;

        if (!Array.isArray(data.holidays)) {
          console.warn(`[business-hours] ${file} 格式錯誤：holidays 不是陣列`);
          continue;
        }

        for (const h of data.holidays) {
          if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
            console.warn(`[business-hours] ${file} 跳過無效日期: ${h.date}`);
            continue;
          }
          HOLIDAY_DATES.add(h.date);
          HOLIDAY_NAMES.set(h.date, h.name ?? "國定假日");
          totalLoaded++;
        }

        console.log(`[business-hours] 載入 ${file}: ${data.holidays.length} 筆`);
      } catch (err) {
        console.error(`[business-hours] 載入 ${file} 失敗:`, err);
      }
    }

    console.log(`[business-hours] 國定假日總計載入 ${totalLoaded} 筆，涵蓋年份檔案 ${files.length} 個`);
  } catch (err) {
    console.error("[business-hours] 載入 holidays 失敗:", err);
  }
}

loadHolidays();

export function isHoliday(dateStr: string): boolean {
  return HOLIDAY_DATES.has(dateStr);
}

export function getHolidayStats(): { totalDates: number; sampleDates: string[] } {
  return {
    totalDates: HOLIDAY_DATES.size,
    sampleDates: Array.from(HOLIDAY_DATES).sort().slice(0, 10),
  };
}

const WEEKDAY_SHORT_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getTaipeiComponents(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  dateStr: string;
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

  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);
  const wk = get("weekday");

  return {
    year,
    month,
    day,
    dayOfWeek: WEEKDAY_SHORT_TO_NUM[wk] ?? 1,
    hour,
    minute: parseInt(get("minute"), 10) || 0,
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
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

export function isWithinBusinessHours(date: Date): boolean {
  const taipei = getTaipeiComponents(date);

  if (isHoliday(taipei.dateStr)) return false;
  if (!BUSINESS_HOURS.workDays.includes(taipei.dayOfWeek)) return false;
  if (taipei.hour < BUSINESS_HOURS.startHour || taipei.hour >= BUSINESS_HOURS.endHour) return false;

  return true;
}

export function findNextBusinessMoment(from: Date): Date {
  if (isWithinBusinessHours(from)) {
    return new Date(from.getTime());
  }

  const MAX_HOURS = 30 * 24;
  const { startHour, workDays } = BUSINESS_HOURS;
  let cursor = new Date(from.getTime());

  for (let i = 0; i < MAX_HOURS; i++) {
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    const taipei = getTaipeiComponents(cursor);

    const isWorkDay = workDays.includes(taipei.dayOfWeek);
    const isNotHoliday = !isHoliday(taipei.dateStr);
    const isStartHour = taipei.hour === startHour;

    if (isWorkDay && isNotHoliday && isStartHour) {
      return taipeiWallToUtcDate(taipei.year, taipei.month, taipei.day, startHour, 0, 0);
    }
  }

  console.warn("[business-hours] findNextBusinessMoment 超過 30 天還沒找到");
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}
