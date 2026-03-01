# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard) V6 Enterprise

## Overview
A commercial-grade omnichannel AI customer service dashboard focused on LINE channel integration. Built with Express + React (Vite) + Tailwind CSS + SQLite. All UI is 100% Traditional Chinese with warm cozy SaaS design (bg-[#faf9f5] cream, bg-stone-800 sidebar, emerald-600 accents).

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui components + recharts + react-day-picker + date-fns
- **Backend**: Express.js API server (port 5000)
- **Database**: SQLite via better-sqlite3 (file: omnichannel.db)
- **Auth**: Session-based with 3-tier RBAC (super_admin / marketing_manager / cs_agent), SHA-256 password hashing
- **AI**: OpenAI API integration (gpt-5.2) for sandbox testing and auto-reply
- **External API**: 一頁商店 (Super Landing) via https://api.super-landing.com/orders.json — field mapping: recipient→buyer_name, mobile→buyer_phone, email→buyer_email, tracking_codes→tracking_number, created_date→created_at; dual-mode lookup: (1) global_order_id direct, (2) date-range + email/phone/name filter (31-day max, paginated fetch)

## Test Accounts
- **admin** / admin123 → role: super_admin, display_name: 系統管理員 (full access)
- **marketing** / mkt123 → role: marketing_manager, display_name: 行銷經理 Amy (knowledge, analytics, settings minus API keys)
- **agent** / agent123 → role: cs_agent, display_name: 客服小李 (chat only)

## 3-Tier RBAC Access Matrix
| Feature | super_admin | marketing_manager | cs_agent |
|---------|------------|-------------------|----------|
| 即時客服 (Chat) | ✓ | ✓ | ✓ |
| AI 與知識庫 | ✓ | ✓ | ✗ |
| 數據戰情室 | ✓ | ✓ | ✗ |
| 團隊管理 | ✓ | ✗ | ✗ |
| 系統設定 | ✓ (full) | ✓ (no API keys) | ✗ |
| API 金鑰設定 | ✓ | ✗ | ✗ |
| 一頁商店 API 設定 | ✓ | ✗ | ✗ |
| 訂單查詢 (chat panel) | ✓ | ✓ | ✓ |

## Project Structure
```
server/
  index.ts         - Express server setup with session middleware
  routes.ts        - All API endpoints (/api/*) with RBAC middleware
  storage.ts       - IStorage interface and SQLiteStorage implementation
  db.ts            - SQLite database setup, schema creation, mock data seeding
  superlanding.ts  - 一頁商店 API client (fetchOrders, lookupOrderById, lookupOrdersByDateAndFilter)
  vite.ts          - Vite dev server integration (DO NOT MODIFY)
  static.ts        - Static file serving for production

client/src/
  App.tsx              - Main app with auth guard, 3-tier RBAC routing, white-label settings
  pages/
    login.tsx          - Login page with 3 test accounts displayed
    chat.tsx           - Real-time chat with CRM panel, order lookup tab, VIP badges, quick replies
    settings.tsx       - API keys, 一頁商店 API, white-label, LINE welcome, human-transfer keywords
    knowledge.tsx      - System prompt, knowledge files, marketing rules, AI sandbox
    team.tsx           - Team CRUD with 3-tier role selector and RBAC info cards
    analytics.tsx      - BI dashboard with custom date range picker (Calendar + Popover)
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Dark sidebar (bg-stone-800) with 3-tier role-based menu filtering

shared/
  schema.ts            - TypeScript interfaces, ROLE_LABELS, ORDER_STATUS_LABELS
```

## Database Schema (SQLite)
- **users**: id, username, password_hash, display_name, role (super_admin/marketing_manager/cs_agent), created_at
- **settings**: key-value store (openai_api_key, line_channel_secret, line_channel_access_token, system_prompt, test_mode, system_name, logo_url, welcome_message, quick_buttons, human_transfer_keywords, superlanding_merchant_no, superlanding_access_key)
- **contacts**: id, platform, platform_user_id, display_name, avatar_url, needs_human, is_pinned, status, tags (JSON), vip_level, order_count, total_spent, last_message_at, created_at
- **messages**: id, contact_id, platform, sender_type (user/ai/admin/system), content, created_at
- **knowledge_files**: id, filename, original_name, size, created_at
- **marketing_rules**: id, keyword, pitch, url, created_at

## API Endpoints
### Auth
- POST /api/auth/login, GET /api/auth/check, POST /api/auth/logout

### Settings (RBAC: super_admin full, marketing_manager partial, sensitive keys super_admin only)
- GET /api/settings, PUT /api/settings, POST /api/settings/test-connection

### Contacts
- GET /api/contacts, GET /api/contacts/:id
- PUT /api/contacts/:id/human, PUT /api/contacts/:id/status, PUT /api/contacts/:id/tags, PUT /api/contacts/:id/pinned

### Messages
- GET /api/contacts/:id/messages, POST /api/contacts/:id/messages

### Orders (一頁商店 API proxy)
- GET /api/contacts/:id/orders — lookup orders for a contact
- GET /api/orders/lookup?q= — order search by global_order_id
- GET /api/orders/search?q=&begin_date=&end_date= — advanced search (email/phone/name + date range, 31-day max)

### Team (super_admin only)
- GET /api/team, POST /api/team, PUT /api/team/:id, DELETE /api/team/:id

### Analytics (managerOrAbove)
- GET /api/analytics?range=today|7d|30d|custom&start=YYYY-MM-DD&end=YYYY-MM-DD

### Marketing Rules (managerOrAbove for CUD, all authenticated for R)
- GET /api/marketing-rules, POST /api/marketing-rules, PUT /api/marketing-rules/:id, DELETE /api/marketing-rules/:id

### Other
- POST /api/webhook/line, POST /api/sandbox/chat, GET/POST/DELETE /api/knowledge-files

## Key Features (V6)
1. **3-Tier RBAC**: super_admin, marketing_manager, cs_agent with granular access control
2. **Custom Date Range Picker**: Calendar popover for arbitrary date ranges in analytics
3. **一頁商店 API Integration**: Dual-mode order lookup — (1) strict global_order_id direct query, (2) advanced date-range + email/phone/name filter with 31-day cap; AI prompt v3 enforces 3-stage escalation: ask order ID → ask date+contact for advanced search → human transfer only as last resort
4. **Order Lookup Panel**: Right-side tabs in chat with customer info + order search
5. **VIP Badges**: Crown icon badges for VIP contacts (level 1-3)
6. **Team CRUD with 3-Tier Roles**: Add/edit/delete with role descriptions
7. **White-label Branding**: Custom system_name and logo_url
8. **Pin/Star Contacts**: Pinned contacts sort to top
9. **Analytics BI Dashboard**: 4 KPI cards, bar chart, pie chart, AI insights
10. **LINE Welcome Settings**: Welcome message + 3 quick buttons
11. **Smart Human-Transfer Keywords**: Comma-separated keywords with tag preview
12. **Marketing Rules Hub**: Full CRUD for keyword→pitch→URL rules
13. **Real OpenAI Integration**: gpt-5.2 sandbox + production AI reply
14. **Real API Test Connection**: POST /api/settings/test-connection for OpenAI (chat completion), LINE (bot info API), 一頁商店 (order API) — super_admin only, with detailed success/failure messages
15. **LINE CSAT Flex Message**: Manual ⭐ button in chat toolbar sends LINE Flex Message with 5-star postback rating buttons; POST /api/contacts/:id/send-rating endpoint; webhook parses postback action=rate&ticket_id&score, stores cs_rating, replies acknowledgement via Reply API; rating displayed in contact info panel; button auto-disabled when cs_rating exists
16. **Chat Image Upload**: Attachment button (Paperclip icon) + drag & drop with visual overlay + file preview thumbnails with remove; uploads via POST /api/chat-upload, images rendered in chat bubbles; LINE Messaging API image push support
17. **Messages Schema**: message_type (text/image/file) + image_url columns with auto-migration

## Sensitive Settings (super_admin only)
openai_api_key, line_channel_secret, line_channel_access_token, superlanding_merchant_no, superlanding_access_key

## Webhook (POST /api/webhook/line)
- Signature verification via HMAC-SHA256 (x-line-signature header)
- Idempotency: processed_events table deduplicates by webhookEventId
- Handles: text messages, postback (rating), image (download via LINE Content API → save to uploads/ → OpenAI Vision analysis), video (download → save → auto-flag needs_human), sticker/audio/location/file (recorded as placeholder), follow/unfollow/join/leave (silently ignored)
- Rating postback: action=rate&ticket_id={id}&score={1-5} → updates cs_rating + reply API
- Image analysis: downloadLineContent() fetches binary from LINE → saves to uploads/ → analyzeImageWithAI() reads file as base64 → sends to gpt-5.2 with vision payload → stores AI reply + pushes to LINE
- Video handling: downloads video → stores as message_type="video" → auto-replies "轉交專人檢視" → sets needs_human=1

## Middleware Chain
- authMiddleware: checks session.authenticated
- superAdminOnly: checks session.userRole === "super_admin"
- managerOrAbove: checks session.userRole in ["super_admin", "marketing_manager"]
