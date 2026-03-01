# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard) V5 Enterprise

## Overview
A commercial-grade omnichannel AI customer service dashboard focused on LINE channel integration. Built with Express + React (Vite) + Tailwind CSS + SQLite. All UI is 100% Traditional Chinese with warm cozy SaaS design (bg-[#faf9f5] cream, bg-stone-800 sidebar, emerald-600 accents).

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui components + recharts
- **Backend**: Express.js API server (port 5000)
- **Database**: SQLite via better-sqlite3 (file: omnichannel.db)
- **Auth**: Session-based with RBAC (admin/agent roles), SHA-256 password hashing
- **AI**: OpenAI API integration (gpt-4o-mini) for sandbox testing

## Test Accounts
- **admin** / admin123 → role: admin, display_name: 系統管理員 (full access)
- **agent** / agent123 → role: agent, display_name: 客服小李 (chat + knowledge only)

## Project Structure
```
server/
  index.ts       - Express server setup with session middleware
  routes.ts      - All API endpoints (/api/*)
  storage.ts     - IStorage interface and SQLiteStorage implementation
  db.ts          - SQLite database setup, schema creation, mock data seeding
  vite.ts        - Vite dev server integration (DO NOT MODIFY)
  static.ts      - Static file serving for production

client/src/
  App.tsx              - Main app with auth guard, RBAC routing, white-label settings
  pages/
    login.tsx          - Login page (warm theme)
    chat.tsx           - Real-time chat with CRM panel, quick replies, pin/star, CSAT trigger
    settings.tsx       - API keys, white-label, LINE welcome, human-transfer keywords (admin only)
    knowledge.tsx      - System prompt, knowledge files, marketing rules, AI sandbox
    team.tsx           - Team member CRUD (create/read/update/delete) management (admin only)
    analytics.tsx      - Data analytics BI dashboard with recharts + date range (admin only)
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Dark warm sidebar (bg-stone-800) with role-based menu, dynamic brand name/logo

shared/
  schema.ts            - TypeScript interfaces for all data models
```

## Database Schema (SQLite)
- **users**: id, username, password_hash, display_name, role (admin/agent), created_at
- **settings**: key-value store (openai_api_key, line_channel_secret, line_channel_access_token, system_prompt, test_mode, system_name, logo_url, welcome_message, quick_buttons, human_transfer_keywords)
- **contacts**: id, platform, platform_user_id, display_name, avatar_url, needs_human, is_pinned, status (pending/processing/resolved), tags (JSON), last_message_at, created_at
- **messages**: id, contact_id, platform, sender_type (user/ai/admin/system), content, created_at
- **knowledge_files**: id, filename, original_name, size, created_at
- **marketing_rules**: id, keyword, pitch, url, created_at

## API Endpoints
### Auth
- POST /api/auth/login, GET /api/auth/check, POST /api/auth/logout

### Settings (admin only for PUT)
- GET /api/settings, PUT /api/settings, POST /api/settings/test-connection

### Contacts
- GET /api/contacts, GET /api/contacts/:id
- PUT /api/contacts/:id/human, PUT /api/contacts/:id/status, PUT /api/contacts/:id/tags, PUT /api/contacts/:id/pinned

### Messages
- GET /api/contacts/:id/messages, POST /api/contacts/:id/messages

### Team (admin only)
- GET /api/team, POST /api/team, PUT /api/team/:id, DELETE /api/team/:id

### Analytics (admin only)
- GET /api/analytics?range=today|7d|30d - Returns KPI (inbound, completion, AI rate, FRT), agent performance, intent distribution, AI insights

### Marketing Rules
- GET /api/marketing-rules, POST /api/marketing-rules, PUT /api/marketing-rules/:id, DELETE /api/marketing-rules/:id

### Other
- POST /api/webhook/line, POST /api/sandbox/chat, GET/POST/DELETE /api/knowledge-files

## Key Features (V5)
1. **Team CRUD with Edit**: Add/edit/delete team members; edit modal for name, password (optional), role
2. **White-label Branding**: Custom system_name and logo_url reflected in sidebar
3. **Pin/Star Contacts**: Pinned contacts sort to top
4. **Analytics BI Dashboard**: Date range selector (today/7d/30d), 4 KPI cards (inbound, completion rate, AI intercept rate, avg FRT for AI & human), bar chart, pie chart (legend-only, no overlapping labels), AI insights
5. **CSAT Trigger**: Status→resolved auto-inserts system message
6. **LINE Welcome Settings**: Welcome message + 3 quick buttons config
7. **Smart Human-Transfer Keywords**: Comma-separated keywords with tag preview; webhook reads dynamically
8. **Marketing Rules Hub**: Full CRUD for keyword→pitch→URL rules in knowledge page
9. **CSV Tip Banner**: Prominent tip in knowledge upload area about CSV format
10. **Updated System Prompt**: Shopping consultant persona (price + purchase links)
11. **RBAC**: Agent role sees only 即時客服 + AI與知識庫; admin sees all 5 menu items
12. **Real OpenAI Integration**: gpt-4o-mini sandbox
13. **Quick Replies + CRM Tags**: Pre-set messages and color-coded tags
