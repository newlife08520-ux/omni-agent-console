export function maskSensitiveInfo(text: string): string {
  let result = text;
  result = result.replace(/09\d{8}/g, (m) => m.substring(0, 4) + "****" + m.substring(8));
  result = result.replace(/(\+?886)?\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4}/g, (m) => {
    if (m.length < 8) return m;
    return m.substring(0, 3) + "****" + m.substring(m.length - 2);
  });
  result = result.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (_m, local: string, domain: string) => {
    const maskedLocal = local.length > 2 ? local.substring(0, 2) + "***" : "***";
    return `${maskedLocal}@${domain}`;
  });
  return result;
}
