/**
 * Phase 2：真正呼叫 Meta Graph API 執行公開留言回覆與隱藏。
 * 以平台 API 回應為準，成功才更新 DB，失敗寫入錯誤欄位。
 */

const GRAPH_API_VERSION = "v19.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface ReplyResult {
  success: boolean;
  reply_id?: string;
  error?: string;
  platform_code?: string;
  platform_response?: string;
}

export interface HideResult {
  success: boolean;
  error?: string;
  platform_code?: string;
  platform_response?: string;
}

/**
 * 發佈公開回覆到一則留言。
 * Endpoint: POST /{comment-id}/comments
 * Body: message=...
 * 需要 Page access token，權限需含 pages_manage_engagement 或 pages_read_engagement（依 Meta 文件）。
 */
export async function replyToComment(params: {
  commentId: string;
  message: string;
  pageAccessToken: string;
}): Promise<ReplyResult> {
  const { commentId, message, pageAccessToken } = params;
  if (!commentId?.trim() || !message?.trim()) {
    return { success: false, error: "comment_id 與 message 必填" };
  }
  if (!pageAccessToken?.trim()) {
    return { success: false, error: "缺少 Page access token" };
  }

  const url = `${GRAPH_BASE}/${commentId.trim()}/comments`;
  const body = new URLSearchParams({
    message: message.trim(),
    access_token: pageAccessToken.trim(),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    let json: { id?: string; error?: { message: string; code?: number; error_subcode?: number } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }

    if (!res.ok) {
      const errMsg = json.error?.message || text || res.statusText;
      const code = json.error?.code;
      return {
        success: false,
        error: errMsg,
        platform_code: code != null ? String(code) : undefined,
        platform_response: text.slice(0, 500),
      };
    }

    const replyId = json.id;
    return {
      success: true,
      reply_id: replyId,
      platform_response: text.slice(0, 500),
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || String(e),
      platform_response: e?.stack?.slice(0, 300),
    };
  }
}

/**
 * 隱藏一則留言。
 * Endpoint: POST /{comment-id}?is_hidden=true
 * 必須使用 Page access token；權限需 pages_manage_engagement。
 */
export async function hideComment(params: {
  commentId: string;
  pageAccessToken: string;
}): Promise<HideResult> {
  const { commentId, pageAccessToken } = params;
  if (!commentId?.trim()) {
    return { success: false, error: "comment_id 必填" };
  }
  if (!pageAccessToken?.trim()) {
    return { success: false, error: "缺少 Page access token" };
  }

  const url = `${GRAPH_BASE}/${commentId.trim()}?is_hidden=true&access_token=${encodeURIComponent(pageAccessToken.trim())}`;

  try {
    const res = await fetch(url, { method: "POST" });
    const text = await res.text();
    let json: { success?: boolean; error?: { message: string; code?: number } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }

    if (!res.ok) {
      const errMsg = json.error?.message || text || res.statusText;
      const code = json.error?.code;
      return {
        success: false,
        error: errMsg,
        platform_code: code != null ? String(code) : undefined,
        platform_response: text.slice(0, 500),
      };
    }

    return {
      success: true,
      platform_response: text.slice(0, 500),
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || String(e),
      platform_response: e?.stack?.slice(0, 300),
    };
  }
}
