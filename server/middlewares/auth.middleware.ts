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
  return res.status(401).json({ message: "????" });
};

export const superAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).session?.userRole === "super_admin") return next();
  return res.status(403).json({ message: "???????" });
};

export const managerOrAbove = (req: Request, res: Response, next: NextFunction) => {
  if (["super_admin", "marketing_manager"].includes((req as any).session?.userRole)) return next();
  return res.status(403).json({ message: "??????????" });
};

export function isSupervisor(req: Request): boolean {
  return ["super_admin", "marketing_manager"].includes((req as any).session?.userRole);
}
