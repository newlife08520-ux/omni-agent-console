/**
 * 私訊安全確認驗收用：對三則測試訊息執行 classifyMessageForSafeAfterSale，輸出 JSON 供文件／實跑紀錄使用。
 * 執行：npx tsx script/run-dm-classifier-check.ts
 */
import { classifyMessageForSafeAfterSale } from "../server/safe-after-sale-classifier";

const cases: { name: string; message: string }[] = [
  { name: "他平台訂單", message: "我在蝦皮買的怎麼還沒到" },
  { name: "詐騙／冒用", message: "我被假客服騙了，對方要我轉帳" },
  { name: "來源不明／查無訂單", message: "查不到我的訂單，我要退款" },
];

console.log(JSON.stringify({
  title: "classifyMessageForSafeAfterSale 實跑結果",
  run_at: new Date().toISOString(),
  cases: cases.map(({ name, message }) => ({
    case_name: name,
    input: message,
    result: classifyMessageForSafeAfterSale(message),
  })),
}, null, 2));
