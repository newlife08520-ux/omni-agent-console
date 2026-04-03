/**
 * /api/analytics「客戶痛點」統計用關鍵字。
 * 使用字串陣列 + includes，不使用 RegExp、不用 "|" 拼接，避免編碼毀損時出現 ?? 導致執行期錯誤。
 */
export const ANALYTICS_CONCERN_KEYWORD_GROUPS: { concern: string; keywords: string[] }[] = [
  {
    concern: "物流配送",
    keywords: ["未到貨", "還沒到", "物流", "配送", "出貨", "貨態", "追蹤", "黑貓", "新竹", "超商取貨"],
  },
  {
    concern: "退換貨",
    keywords: ["退貨", "退款", "換貨", "取消訂單", "申請退"],
  },
  {
    concern: "商品瑕疵",
    keywords: ["瑕疵", "壞掉", "破掉", "錯誤", "缺件", "漏寄", "與描述不符"],
  },
  {
    concern: "價格優惠",
    keywords: ["價格", "太貴", "特價", "折扣", "優惠", "活動", "降價"],
  },
  {
    concern: "效期保存",
    keywords: ["效期", "過期", "保存", "變質", "日期"],
  },
  {
    concern: "客服體驗",
    keywords: ["客服", "不理", "態度", "敷衍", "沒人回"],
  },
  {
    concern: "金流支付",
    keywords: ["付款", "刷卡", "超商", "轉帳", "扣款", "退款未到"],
  },
  {
    concern: "其他疑慮",
    keywords: ["詐騙", "假的", "投訴", "檢舉"],
  },
];
