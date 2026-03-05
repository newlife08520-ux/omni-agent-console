/**
 * 資料目錄：DB 與 uploads 根目錄，支援 production 持久化（Railway Volume 掛載 /data）。
 * - production 未設 DATA_DIR 時預設 /data
 * - development 未設時用 process.cwd()
 */
import path from "path";
import fs from "fs";

function getDataDirRaw(): string {
  if (process.env.DATA_DIR && process.env.DATA_DIR.trim()) {
    return path.resolve(process.env.DATA_DIR.trim());
  }
  if (process.env.NODE_ENV === "production") {
    return "/data";
  }
  return process.cwd();
}

let _dataDir: string | null = null;

export function getDataDir(): string {
  if (_dataDir === null) _dataDir = getDataDirRaw();
  return _dataDir;
}

export function getUploadsDir(): string {
  return path.join(getDataDir(), "uploads");
}

/** 確保 DATA_DIR 與 uploads 目錄存在（啟動時呼叫，DB 與 routes 使用前） */
export function ensureDataDirs(): void {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const uploads = getUploadsDir();
  if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
}
