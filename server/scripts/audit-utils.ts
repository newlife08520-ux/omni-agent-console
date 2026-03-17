/**
 * Payload audit 共用：遮罩規則與 key 收集
 * 依 CURSOR_ORDER_CX_WORLDCLASS_PLAN.md C 章
 */
export function maskName(name: string | null | undefined): string {
  if (name == null || typeof name !== "string" || name.trim() === "") return "***";
  const s = name.trim();
  if (s.length <= 1) return s + "**";
  return s[0] + "**";
}

export function maskPhone(phone: string | null | undefined): string {
  if (phone == null || typeof phone !== "string") return "**********";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 3) return "**********";
  return "*******" + digits.slice(-3);
}

export function maskEmail(email: string | null | undefined): string {
  if (email == null || typeof email !== "string" || !email.includes("@")) return "***@***";
  const [local, domain] = email.split("@");
  if (!domain) return "***@***";
  const maskedLocal = local.length <= 2 ? "***" : (local.slice(0, 2) + "***");
  return maskedLocal + "@" + domain;
}

export function maskAddress(address: string | null | undefined): string {
  if (address == null || typeof address !== "string" || address.trim() === "") return "***";
  const s = address.trim();
  if (s.length <= 3) return s + "***";
  return s.slice(0, 3) + "***";
}

/** 遞迴收集物件所有 key（含 nested），回傳 key 路徑陣列 */
export function collectKeys(obj: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (obj == null || typeof obj !== "object") return out;
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    const v = o[k];
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...collectKeys(v, path));
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
      out.push(...collectKeys(v[0], path + "[]"));
    }
  }
  return out;
}

/** 對單一層級 key 排序去重 */
export function uniqueSortedKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}
