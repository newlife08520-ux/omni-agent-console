import type { Request, Response, NextFunction } from "express";

/** 解析路由 :id 參數為數字；無效或空則回 null（呼叫端回 400） */
export function parseIdParam(value: string | string[] | undefined): number | null {
  if (value == null || value === "") return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === "") return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || !Number.isInteger(n)) return null;
  return n;
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).session?.authenticated === true) return next();
  return res.status(401).json({ message: "請先登入" });
};

export const superAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).session?.userRole === "super_admin") return next();
  return res.status(403).json({ message: "權限不足，需要最高管理員" });
};

/**
 * Phase 106.5：除 super_admin 登入外，若設定了 ADMIN_DEBUG_TOKEN，可於 query 帶 `?token=` 供 curl／腳本呼叫（與 session 擇一）。
 */
export const superAdminOrDebugToken = (req: Request, res: Response, next: NextFunction) => {
  const envTok = process.env.ADMIN_DEBUG_TOKEN?.trim();
  const q = req.query.token;
  const qTok = typeof q === "string" ? q.trim() : Array.isArray(q) ? String(q[0] ?? "").trim() : "";
  if (envTok && qTok === envTok) return next();
  if ((req as any).session?.authenticated === true && (req as any).session?.userRole === "super_admin") return next();
  if (!(req as any).session?.authenticated) {
    return res.status(401).json({ error: "unauthorized", message: "請先登入，或設定 ADMIN_DEBUG_TOKEN 後於 URL 加上 ?token=" });
  }
  return res.status(403).json({ error: "forbidden", message: "權限不足，需要最高管理員或有效 token" });
};

export const managerOrAbove = (req: Request, res: Response, next: NextFunction) => {
  if (["super_admin", "marketing_manager"].includes((req as any).session?.userRole)) return next();
  return res.status(403).json({ message: "權限不足，需要管理員以上" });
};

export function isSupervisor(req: Request): boolean {
  return ["super_admin", "marketing_manager"].includes((req as any).session?.userRole);
}
