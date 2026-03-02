# Omnichannel AI Agent Dashboard - Multi-Brand

## Overview
This project is a commercial-grade Multi-Brand Omnichannel Helpdesk built with a modern web stack. It supports multiple LINE accounts and Facebook pages, organized under Brand Workspaces, each with its own AI persona and knowledge base. The system aims to provide a comprehensive customer service solution with advanced AI capabilities for auto-reply and seamless human agent handoff. The UI is designed to be warm and user-friendly, catering specifically to Traditional Chinese users.

The business vision is to empower businesses with efficient, scalable, and personalized customer support across various digital channels, reducing operational costs while improving customer satisfaction. The market potential lies in e-commerce, service industries, and any business managing customer interactions across multiple brands or platforms. The project's ambition is to be a leading AI-powered customer service platform in the Traditional Chinese market.

## User Preferences
I prefer all UI to be 100% Traditional Chinese with a warm cozy SaaS design (bg-[#faf9f5] cream, bg-stone-800 sidebar, emerald-600 accents).

## System Architecture
The system is built on a modern full-stack architecture:
- **Frontend**: React, Vite, Tailwind CSS, shadcn/ui, recharts, react-day-picker, and date-fns provide a rich, interactive user experience.
- **Backend**: An Express.js API server handles all business logic and data operations.
- **Database**: SQLite is used as the primary data store, managed via `better-sqlite3`.
- **Authentication**: Session-based authentication with a 3-tier Role-Based Access Control (RBAC) system (super_admin, marketing_manager, cs_agent) secures the application. Passwords are hashed using SHA-256.
- **AI Integration**: OpenAI API (gpt-5.2) is integrated for AI-driven auto-replies, sandbox testing, and content analysis, featuring an explicit handoff mechanism where AI honestly identifies itself and asks customers if they want to be transferred to a human agent.
- **Multi-Brand Support**: The architecture includes `brands` and `channels` tables to support multiple brands, each with unique AI personas and configurations. Webhooks are dynamically routed based on brand and channel.
- **UI/UX Decisions**: The design emphasizes a warm and cozy aesthetic with specific color schemes (cream, dark sidebar, emerald accents) and a fully localized Traditional Chinese interface.
- **Key Features**:
    - **3-Tier RBAC**: Granular access control for different user roles.
    - **Multi-Brand Workspaces**: Support for distinct brands, each with its AI persona and settings.
    - **轉接真人客服 (Explicit Handoff)**: AI honestly identifies itself and asks if the customer wants to be transferred. Backend still sets needs_human=1 to pause AI and alert agents. Sandbox shows debug info (transfer reason + tool call log) as a separate system bubble — debug info is NOT embedded in the AI reply text.
    - **AI 擬真測試沙盒 (Enhanced Sandbox)**: Full-fidelity AI testing with: brand persona applied (per-brand system_prompt), knowledge base + marketing rules + image assets injected, complete tool chain (order lookup, human handoff, image send), prompt preview dialog showing full OpenAI prompt, context stat cards (persona/knowledge/rules/assets), tool call activity log display, quick start suggestions, reset conversation, brand_id passed to all sandbox endpoints including image upload.
    - **一頁商店 (Super Landing) API Integration**: Triple-mode order lookup with product matching, fuzzy search, and dynamic catalog injection for AI queries. Cross-brand fallback: when primary brand returns no results, automatically tries all other brands with configured API credentials. Knowledge CSV product→page_id mapping used as fallback when SuperLanding page name fuzzy matching fails.
    - **Real-time Chat (SSE)**: Server-Sent Events (SSE) push real-time message notifications to the frontend. SSE endpoint at `/api/events` (session-authenticated). Fallback 5s polling via react-query `refetchInterval`. Features include CRM panel, order lookup, VIP badges, quick replies, and image upload with AI analysis.
    - **Facebook Messenger Webhook**: Full webhook handler at `GET/POST /api/webhook/facebook`. GET handles Hub verification (verify token: `FB_VERIFY_TOKEN` env var). POST processes messaging events, routes by Page ID→`channels.bot_id`, supports text + image attachments, human keyword transfer, and AI auto-reply via `sendFBMessage`. Admin can reply to Messenger contacts from the dashboard.
    - **Analytics BI Dashboard**: Provides key performance indicators, charts, and AI insights.
    - **Knowledge Base Management**: Support for various file types (xlsx, docx, pdf, csv, txt, md) for AI knowledge base and marketing rules.
    - **White-labeling**: Custom branding options for system name and logo.
    - **Messaging Features**: LINE Welcome Messages, quick buttons, human-transfer keywords, and CSAT rating collection via Flex Messages.
    - **Dual Rating System**: Separate AI rating (`ai_rating`) and human agent rating (`cs_rating`) per contact. Each has its own LINE Flex Message template (purple for AI, green for human) and distinct postback actions (`rate_ai` / `rate`). Two separate rating buttons in the chat toolbar.
    - **Searchable Product Page Selector**: Order lookup "商品+電話" mode uses a text filter input with scrollable list instead of a dropdown, allowing quick search by page name or prefix code.
    - **Robust File Handling**: Includes filename encoding fixes, BOM stripping, and content extraction for diverse document types.

## External Dependencies
- **OpenAI API**: Utilized for AI capabilities, including chat completion (gpt-5.2), function calling, and vision analysis.
- **一頁商店 (Super Landing) API**: Integrated for order lookup and product page catalog retrieval (https://api.super-landing.com).
- **LINE Messaging API**: Used for handling LINE webhooks, sending messages, and content retrieval (images, videos). Webhook at `/api/webhook/line`.
- **Facebook Graph API (v19.0)**: Used for Facebook Messenger webhook handling and message sending via `me/messages` endpoint.
- **React (Vite)**: Frontend framework and build tool.
- **Express.js**: Backend web application framework.
- **SQLite**: Database management system.
- **Tailwind CSS**: Utility-first CSS framework for styling.
- **shadcn/ui**: UI component library.
- **recharts**: Charting library for data visualization.
- **react-day-picker, date-fns**: For date selection and manipulation.
- **better-sqlite3**: SQLite driver for Node.js.
- **multer**: Middleware for handling `multipart/form-data`.
- **xlsx**: Library for reading and writing Excel files.
- **jszip**: Library for creating, reading, and editing .zip files.

## Multimedia & Vision
- **LINE Image/Video Download**: `downloadLineContent(messageId, ext, channelAccessToken)` downloads LINE content using per-channel token for multi-brand support. Falls back to global token.
- **External Image Download**: `downloadExternalImage(url)` downloads images from external URLs (e.g., FB attachments) to local `/uploads/` folder.
- **Image-to-DataURI**: `imageFileToDataUri(filePath)` converts local image files to base64 data URIs for OpenAI Vision API.
- **AI Vision Analysis**: `analyzeImageWithAI(imageFilePath, contactId, lineToken, platform)` performs full vision analysis with:
  - Conversation history including prior images as Vision content
  - Safety fallback: explicitly injects current image if not found in recent messages
  - Full tool-call loop (order lookup, human handoff, image assets) up to 3 rounds
  - Multi-platform reply (LINE push / FB message)
  - Per-brand system prompt + image handling guidelines
- **autoReplyWithAI**: Now includes image messages in conversation context as Vision content for contextual awareness. Instrumented with AI logging, high-risk detection, issue type detection, and contact status management.
- **Frontend Lightbox**: Clicking chat images opens a full-screen overlay preview instead of new tab. Close via X button or clicking backdrop.
- **FB Webhook Images**: Downloads FB image attachments locally, triggers AI vision analysis for non-human-flagged contacts.

## Unified Order Query Service
- **server/order-service.ts**: Chains SuperLanding → SHOPLINE → not found. Each result includes `source: 'superlanding' | 'shopline' | 'unknown'`.
- **server/shopline.ts**: SHOPLINE Open API integration. Supports lookup by order number, phone, email, name. Config: `shopline_store_domain` + `shopline_api_token` stored per brand.
- **OrderInfo.source**: Optional field tracking which platform the order came from.
- **executeToolCall**: Updated to use unified order service for all 3 lookup tools. Automatically updates `contacts.order_source`.

## AI Logging & Risk Detection
- **ai_logs table**: Stores every AI response with prompt_summary, knowledge_hits, tools_called, transfer_triggered, transfer_reason, result_summary, token_usage, model, response_time_ms.
- **High-Risk Auto-Transfer**: Keywords (legal threats, profanity, extreme anger) trigger automatic `high_risk` status and human transfer.
- **Multi-Round Failure Detection**: If 3+ tool calls fail or order lookups fail 2+ times, auto-escalate to `awaiting_human`.
- **Issue Type Detection**: Automatically detects issue type from conversation keywords (order_inquiry, product_consult, return_refund, complaint, order_modify, general).

## Expanded Contact Status System
- **Statuses**: pending, processing, resolved, ai_handling, awaiting_human, high_risk, closed (was: pending, processing, resolved)
- **Issue Types**: order_inquiry, product_consult, return_refund, complaint, order_modify, general, other
- **Order Sources**: superlanding, shopline, unknown
- **Schema maps**: CONTACT_STATUS_LABELS, CONTACT_STATUS_COLORS, ISSUE_TYPE_LABELS, ISSUE_TYPE_COLORS, ORDER_SOURCE_LABELS in shared/schema.ts

## Webhook Architecture
- **ACK-first pattern**: Both LINE and FB webhooks respond 200 immediately (< 2s), then process events asynchronously
- **Signature verification**: LINE validates `x-line-signature` via HMAC-SHA256 (rejects 403 on mismatch). FB validates `x-hub-signature-256` via HMAC-SHA256 when `fb_app_secret` setting is configured.
- **Idempotency**: `processed_events` table stores event IDs. Events marked processed BEFORE processing begins (at-most-once delivery). TTL cleanup removes events older than 7 days on startup.
- **Per-contact lock**: `withContactLock(contactId, fn)` ensures sequential processing per contact. Prevents duplicate/out-of-order AI replies. 60s timeout prevents indefinite blocking.
- **Transfer triggers (code-enforced)**: high-risk keywords, explicit human request keywords, order lookup failures (2+), max tool loops (3+). Order source is NOT a transfer trigger.

## Analytics Upgrade
- **New KPI**: AI resolution rate, transfer rate, order query success rate (from ai_logs)
- **New Charts**: Issue type distribution, order source distribution, transfer reason ranking, platform distribution
- **API**: `/api/analytics` now returns issueTypeDistribution, orderSourceDistribution, transferReasons, platformDistribution