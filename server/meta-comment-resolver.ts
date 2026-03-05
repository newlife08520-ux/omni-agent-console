/**
 * Phase 1：貼文標題 fallback、商品多層判定、導流 LINE 解析。
 * 不呼叫外部 API，僅依 DB mapping / 關鍵字 / 粉專設定產出結果。
 */
import type { MetaDetectedProductSource, MetaPostTitleSource } from "@shared/schema";
import * as storage from "./meta-comments-storage";

export interface ResolvedPostDisplay {
  post_display_name: string;
  detected_post_title_source: MetaPostTitleSource;
}

export interface ResolvedProduct {
  detected_product_name: string | null;
  detected_product_source: MetaDetectedProductSource;
}

export interface ResolvedTargetLine {
  target_line_type: "general" | "after_sale" | null;
  target_line_value: string | null;
}

export interface ResolvedCommentMetadata {
  post_display_name: string;
  detected_post_title_source: MetaPostTitleSource;
  detected_product_name: string | null;
  detected_product_source: MetaDetectedProductSource;
  target_line_type: "general" | "after_sale" | null;
  target_line_value: string | null;
}

/**
 * 貼文顯示名稱 fallback 優先順序：
 * 1. Graph API 抓到的 post title / message（若傳入）
 * 2. mapping 設定的 post_name
 * 3. post_id
 */
export function resolvePostDisplayName(params: {
  post_id: string;
  post_name_from_mapping?: string | null;
  post_title_from_graph?: string | null;
}): ResolvedPostDisplay {
  if (params.post_title_from_graph && params.post_title_from_graph.trim()) {
    return {
      post_display_name: params.post_title_from_graph.trim(),
      detected_post_title_source: "graph_api",
    };
  }
  if (params.post_name_from_mapping && params.post_name_from_mapping.trim()) {
    return {
      post_display_name: params.post_name_from_mapping.trim(),
      detected_post_title_source: "mapping",
    };
  }
  return {
    post_display_name: params.post_id,
    detected_post_title_source: "post_id",
  };
}

/**
 * 商品多層判定：
 * 第一層：post_id mapping
 * 第二層：post 標題/名稱關鍵字
 * 第三層：留言內容關鍵字
 * 第四層：粉專預設商品
 * 第五層：未判定
 */
export function resolveProductDetection(params: {
  brand_id: number | null;
  page_id: string;
  post_id: string;
  post_display_text: string;
  message: string;
  page_default_product_name?: string | null;
}): ResolvedProduct {
  const { brand_id, page_id, post_id, post_display_text, message, page_default_product_name } = params;
  const mapping = storage.getMappingForComment(brand_id, page_id, post_id);
  if (mapping?.product_name?.trim()) {
    return {
      detected_product_name: mapping.product_name.trim(),
      detected_product_source: "post_mapping",
    };
  }
  const postText = (post_display_text || "").trim();
  const keywordsPost = storage.getMetaProductKeywords(brand_id ?? undefined).filter((k) => k.match_scope === "post");
  for (const k of keywordsPost) {
    if (postText && k.keyword && postText.includes(k.keyword)) {
      return {
        detected_product_name: k.product_name,
        detected_product_source: "post_keyword",
      };
    }
  }
  const msgText = (message || "").trim();
  const keywordsComment = storage.getMetaProductKeywords(brand_id ?? undefined).filter((k) => k.match_scope === "comment");
  for (const k of keywordsComment) {
    if (msgText && k.keyword && msgText.includes(k.keyword)) {
      return {
        detected_product_name: k.product_name,
        detected_product_source: "comment_keyword",
      };
    }
  }
  if (page_default_product_name?.trim()) {
    return {
      detected_product_name: page_default_product_name.trim(),
      detected_product_source: "page_default",
    };
  }
  return {
    detected_product_name: null,
    detected_product_source: "none",
  };
}

/**
 * 依粉專設定取得導流 LINE（一般導購 / 售後客訴）。
 */
export function resolveTargetLine(params: {
  page_id: string;
  line_type: "general" | "after_sale";
}): ResolvedTargetLine {
  const settings = storage.getMetaPageSettingsByPageId(params.page_id);
  if (!settings) {
    return { target_line_type: null, target_line_value: null };
  }
  const value = params.line_type === "general" ? settings.line_general : settings.line_after_sale;
  if (!value?.trim()) {
    return { target_line_type: null, target_line_value: null };
  }
  return {
    target_line_type: params.line_type,
    target_line_value: value.trim(),
  };
}

/**
 * 一次解析留言所需的所有 metadata：貼文顯示名、商品判定、導流 LINE。
 * 導流 LINE 依意圖簡化：若為敏感/客訴用 after_sale，否則用 general。
 */
export function resolveCommentMetadata(params: {
  brand_id: number | null;
  page_id: string;
  post_id: string;
  post_name?: string | null;
  post_title_from_graph?: string | null;
  message: string;
  is_sensitive_or_complaint?: boolean;
}): ResolvedCommentMetadata {
  const mapping = storage.getMappingForComment(params.brand_id ?? null, params.page_id, params.post_id);
  const postNameFromMapping = mapping?.post_name ?? params.post_name ?? null;

  const postResolved = resolvePostDisplayName({
    post_id: params.post_id,
    post_name_from_mapping: postNameFromMapping,
    post_title_from_graph: params.post_title_from_graph,
  });

  const pageSettings = storage.getMetaPageSettingsByPageId(params.page_id);
  const pageDefaultProduct = pageSettings?.default_product_name ?? null;

  const productResolved = resolveProductDetection({
    brand_id: params.brand_id ?? null,
    page_id: params.page_id,
    post_id: params.post_id,
    post_display_text: postResolved.post_display_name,
    message: params.message,
    page_default_product_name: pageDefaultProduct,
  });

  const lineType = params.is_sensitive_or_complaint ? "after_sale" : "general";
  const lineResolved = resolveTargetLine({ page_id: params.page_id, line_type: lineType });

  return {
    post_display_name: postResolved.post_display_name,
    detected_post_title_source: postResolved.detected_post_title_source,
    detected_product_name: productResolved.detected_product_name,
    detected_product_source: productResolved.detected_product_source,
    target_line_type: lineResolved.target_line_type,
    target_line_value: lineResolved.target_line_value,
  };
}
