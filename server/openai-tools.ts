import type OpenAI from "openai";

export const orderLookupTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "lookup_order_by_id",
      description:
        "用訂單編號查詢訂單。支援短編號（如 KBT58265、DEN12345）和長數字編號（如 20260404055000004）。客人提供編號就直接查。",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "客人提供的訂單編號",
          },
        },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_order_by_product_and_phone",
      description:
        "用商品名稱加手機號碼查詢訂單。適合客人說「我買了冒險包，手機 0912345678」的情境。",
      parameters: {
        type: "object",
        properties: {
          product_index: {
            type: "integer",
            description: "如果客人指定了第幾個商品（例如第 3 個），填入數字。沒指定就不填。",
          },
          product_name: {
            type: "string",
            description: "客人提到的商品名稱關鍵字",
          },
          phone: {
            type: "string",
            description: "客人的手機號碼",
          },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_order_by_date_and_contact",
      description:
        "用下單日期範圍加聯絡資訊查詢訂單。適合客人說「我上週下的單」的情境。",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "客人的手機、Email 或姓名",
          },
          begin_date: {
            type: "string",
            description: "查詢起始日 YYYY-MM-DD",
          },
          end_date: {
            type: "string",
            description: "查詢結束日 YYYY-MM-DD",
          },
          page_id: {
            type: "string",
            description: "銷售頁 ID（可選）",
          },
        },
        required: ["contact", "begin_date", "end_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_more_orders",
      description:
        "查詢同一手機號碼在同一銷售頁的更多訂單。用於客人問「還有其他訂單嗎」。",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "客人手機號碼" },
          page_id: { type: "string", description: "銷售頁 ID（可選）" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_more_orders_shopline",
      description:
        "查詢同一手機號碼在同一商店的更多訂單。用於客人問「還有其他訂單嗎」。",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "客人手機號碼" },
          page_id: { type: "string", description: "頁面 ID（可選）" },
        },
        required: ["phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_order_by_phone",
      description:
        "用手機號碼查詢所有訂單。客人給了手機號碼就直接查，不需要先問商品名稱。會合併查詢各管道的訂單。",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "客人手機號碼" },
        },
        required: ["phone"],
      },
    },
  },
];

export const productRecommendTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "recommend_products",
      description:
        "當客人問商品推薦、想看有什麼商品、問特定需求（有什麼推薦、哪個多人買、適合送禮嗎、有沒有新品、某某商品介紹）時呼叫。系統會回傳商品資訊含價格和購買連結。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "客人提到的商品關鍵字或需求，例如：包包、冒險包、送禮、熱銷、吸塵器",
          },
        },
        required: ["keyword"],
      },
    },
  },
];

export const humanHandoffTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description:
        "轉接給真人客服。⚠️ 重要：除非客人明確說要找真人，否則呼叫前必須先問過客人意願！" +
        "呼叫前必須先回覆一句話給客人（例如：好的，我幫您轉給專人處理，請稍等）。" +
        "絕對不可以只呼叫工具不回覆任何文字。" +
        "使用情境分三類：" +
        "(1) 直接轉：客人明確說「轉人工」「找客服」「我要真人」、客訴/法律字眼/極度生氣" +
        "(2) 必須先問再轉：付款糾紛、退款爭議、改訂單、改地址、客人**堅持**取消／堅持退貨、特殊個案" +
        "(3) 不要轉：查訂單、問商品、問出貨進度、問付款狀態、一般問題（這些 AI 自己處理）；" +
        "**客人第一句僅說想取消訂單／退貨（尚未堅持）→ 不要轉人工**，先同理、問原因、走挽留與表單流程。",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "轉接原因，例如：explicit_human_request（客人明確要求）、" +
              "user_confirmed_transfer（客人同意轉接）、" +
              "high_risk_emotional（客人極度不滿）、" +
              "complaint_escalation（客訴升級）",
          },
          user_confirmed: {
            type: "boolean",
            description:
              "客人是否已經明確同意轉接？" +
              "true = 客人說「好」「轉接吧」「請幫我轉」或客人主動要求轉真人。" +
              "false = AI 還沒問過客人意願（如果這個是 false 但 reason 不是 explicit_human_request 或 high_risk，工具會拒絕）",
          },
        },
        required: ["user_confirmed"],
      },
    },
  },
];

export const imageTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "send_image_to_customer",
      description:
        "傳送商品圖片給客人。用 image_name 指定圖片名稱，系統會從圖庫找到對應圖片傳送。可同時附帶文字訊息。",
      parameters: {
        type: "object",
        properties: {
          image_name: {
            type: "string",
            description: "圖片名稱（從系統圖庫中找）",
          },
          text_message: {
            type: "string",
            description: "隨圖片一起傳的文字訊息",
          },
        },
        required: ["image_name"],
      },
    },
  },
];
