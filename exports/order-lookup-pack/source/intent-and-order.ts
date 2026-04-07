/**
 * 意圖強度判斷與訂單／金流／物流編號辨識
 * 用於案件優先級、假需求過濾、溫和引導
 */
import type { IntentLevel, OrderNumberType } from "@shared/schema";

const HIGH_INTENT_PATTERNS = [
  /\b訂單編號\s*[：:]*\s*[\w\-]+/i,
  /\b(我的\s*)?訂單\s*(是|為|：|:)\s*[\w\-]+/i,
  /\b(缺貨|欠貨|還沒到|未出貨|出貨了沒|什麼時候到)\b/,
  /\b(退款|退貨|換貨|取消訂單)\s*(申請|要|想|可以嗎)/i,
  /\b(收到\s*)?(瑕疵|損壞|壞掉|破掉|錯的)\b/,
  /\b(要買|想買|下單)\s*(但|卻)\s*(卡|失敗|無法|不能)/i,
  /\b(KBT|ORD|MRQ|MRH|DEN)\s*\d+/i,
  /\d{5,}\s*(訂單|單號)/,
];

const MEDIUM_INTENT_PATTERNS = [
  /\b(商品|產品)\s*(差異|比較|哪個好)/i,
  /\b(價格|多少錢|優惠|折扣|活動)/i,
  /\b(何時\s*)?(到貨|補貨|有貨)/i,
  /\b(轉人工|轉真人|找客服|要真人)/i,
];

const LOW_INTENT_INDICATORS = [
  /^[\s\W]*$/,  // 幾乎無文字
  /^(好|嗯|喔|哦|謝謝|感謝)$/,
  /^(1|2|3|一|二|三)$/,
];

/** 判斷單則訊息的意圖強度（不考慮歷史行為） */
export function detectIntentLevelFromText(text: string): IntentLevel {
  const t = (text || "").trim();
  if (t.length === 0) return "low";
  for (const p of LOW_INTENT_INDICATORS) {
    if (p.test(t)) return "low";
  }
  for (const p of HIGH_INTENT_PATTERNS) {
    if (p.test(t)) return "high";
  }
  for (const p of MEDIUM_INTENT_PATTERNS) {
    if (p.test(t)) return "medium";
  }
  if (t.length >= 15 && /[訂單出貨退款缺貨到貨查詢]/.test(t)) return "high";
  if (t.length >= 8) return "medium";
  return "low";
}

/** 結合近期按鈕／訊息行為判斷意圖（亂點防呆：短時間多個不相干主題 → 降為 medium/low） */
export function detectIntentLevel(
  currentText: string,
  recentContents: string[] = []
): IntentLevel {
  const fromText = detectIntentLevelFromText(currentText);
  if (fromText === "low") return "low";
  const recent = recentContents.slice(-6).filter(Boolean);
  if (recent.length < 3) return fromText;
  const topics = new Set<string>();
  for (const c of recent) {
    if (/欠貨|缺貨|到貨|補貨/.test(c)) topics.add("stock");
    if (/訂單|查單|物流|出貨/.test(c)) topics.add("order");
    if (/優惠|價格|折扣/.test(c)) topics.add("promo");
    if (/轉人工|真人|客服/.test(c)) topics.add("human");
  }
  if (topics.size >= 3) return "medium";
  return fromText;
}

/** 辨識輸入是否為編號類，以及較可能為訂單／金流／物流／電話 */
export function classifyOrderNumber(input: string): OrderNumberType {
  const s = (input || "").trim().replace(/\s/g, "");
  if (s.length === 0) return "unknown";

  if (/^09\d{8}$/.test(s) || /^0\d{9}$/.test(s)) return "phone";
  if (s.length <= 5 && /^\d+$/.test(s)) return "pending_review";
  if (/^\d{5}$/.test(s) && /末五碼|後五碼|尾碼/.test(input)) return "payment_id";

  /** Shopline 等官網：15～22 位純數字訂單號（略早於下方 pending_review 的 \d{6,}） */
  if (/^\d{15,22}$/.test(s)) {
    if (/交易序號|金流|付款\s*編號|授權碼|刷卡碼/i.test(input)) return "payment_id";
    return "order_id";
  }

  if (/^(KBT|ORD|MRQ|MRH|DEN|EC|SL)\s*\d+/i.test(s) || /^[A-Z]{2,4}\d{5,}$/i.test(s)) return "order_id";
  if (/^T\d{10,}$/i.test(s) || /交易序號|金流|付款.*編號/i.test(input)) return "payment_id";
  if (/^[0-9]{10,14}$/.test(s) && !/^09/.test(s)) return "logistics_id";
  if (/^[a-z0-9]{10,}$/i.test(s) && /宅配|包裹|物流|黑貓|新竹|大榮/i.test(input)) return "logistics_id";

  if (/^\d{6,}$/.test(s)) return "pending_review";
  if (/^[A-Z0-9\-]{6,}$/i.test(s)) return "pending_review";
  return "unknown";
}

/** 依意圖與標籤計算案件優先級 1=最高 */
export function computeCasePriority(intentLevel: IntentLevel | null, tags: string[]): number {
  const tagSet = new Set(tags || []);
  if (tagSet.has("出貨延遲") || tagSet.has("缺貨 / 欠貨") || tagSet.has("退款 / 取消") || tagSet.has("客訴")) return 1;
  if (tagSet.has("訂單查詢") && intentLevel === "high") return 1;
  if (intentLevel === "high") return 2;
  if (tagSet.has("待人工接手") || tagSet.has("高意圖")) return 2;
  if (intentLevel === "medium") return 3;
  if (tagSet.has("待訂單編號")) return 3;
  if (intentLevel === "low" || tagSet.has("低意圖")) return 5;
  return 4;
}

/** 建議從內容自動加上的標籤（不覆蓋既有，只追加） */
export function suggestTagsFromContent(text: string, currentTags: string[] = []): string[] {
  const have = new Set(currentTags);
  const add: string[] = [];
  if (/訂單|查單|出貨|物流/.test(text) && !have.has("訂單查詢")) add.push("訂單查詢");
  if (/缺貨|欠貨|補貨|到貨/.test(text) && !have.has("缺貨 / 欠貨")) add.push("缺貨 / 欠貨");
  if (/退款|退貨|取消/.test(text) && !have.has("退款 / 取消")) add.push("退款 / 取消");
  if (/優惠|折扣|價格|活動/.test(text) && !have.has("優惠詢問")) add.push("優惠詢問");
  if (/商品|產品|比較|差異/.test(text) && !have.has("商品諮詢")) add.push("商品諮詢");
  return add;
}
