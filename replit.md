# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard) V4 Enterprise

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
    settings.tsx       - API keys, white-label branding (system_name, logo_url) (admin only)
    knowledge.tsx      - System prompt, knowledge files, AI sandbox (OpenAI)
    team.tsx           - Team member CRUD management (admin only)
    analytics.tsx      - Data analytics dashboard with recharts (admin only)
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Dark warm sidebar (bg-stone-800) with role-based menu, dynamic brand name/logo

shared/
  schema.ts            - TypeScript interfaces for all data models
```

## Database Schema (SQLite)
- **users**: id, username, password_hash, display_name, role (admin/agent), created_at
- **settings**: key-value store (openai_api_key, line_channel_secret, line_channel_access_token, system_prompt, test_mode, system_name, logo_url)
- **contacts**: id, platform, platform_user_id, display_name, avatar_url, needs_human, is_pinned, status (pending/processing/resolved), tags (JSON), last_message_at, created_at
- **messages**: id, contact_id, platform, sender_type (user/ai/admin/system), content, created_at
- **knowledge_files**: id, filename, original_name, size, created_at

## API Endpoints
### Auth
- POST /api/auth/login - Login (returns user info + role)
- GET /api/auth/check - Check auth status
- POST /api/auth/logout - Logout

### Settings (admin only for PUT)
- GET /api/settings - Get all settings
- PUT /api/settings - Update a setting {key, value}
- POST /api/settings/test-connection - Mock connection test

### Contacts
- GET /api/contacts - List contacts (sorted: is_pinned DESC, last_message_at DESC)
- GET /api/contacts/:id - Get single contact
- PUT /api/contacts/:id/human - Toggle human mode
- PUT /api/contacts/:id/status - Update status (auto-inserts CSAT system message on "resolved")
- PUT /api/contacts/:id/tags - Update tags array
- PUT /api/contacts/:id/pinned - Toggle pin/star

### Messages
- GET /api/contacts/:id/messages - Get messages (supports ?since_id=)
- POST /api/contacts/:id/messages - Send admin message

### Team (admin only)
- GET /api/team - List all users as team members
- POST /api/team - Create new user {username, password, display_name, role}
- DELETE /api/team/:id - Delete user (cannot delete self)

### Analytics (admin only)
- GET /api/analytics - Returns mock KPI data, agent performance, intent distribution, AI insights

### Other
- POST /api/webhook/line - LINE webhook with signature verification
- POST /api/sandbox/chat - Real OpenAI API sandbox
- GET/POST/DELETE /api/knowledge-files - Knowledge file management

## Key Features (V4)
1. **Team CRUD**: Add/delete team members with username, password, display_name, role
2. **White-label Branding**: Custom system_name and logo_url, reflected in sidebar dynamically
3. **Pin/Star Contacts**: Star icon toggles is_pinned, pinned contacts always sort to top
4. **Analytics Dashboard**: KPI cards, Bar chart (agent performance), Pie chart (intent distribution), AI insights (pain points + suggestions) using recharts
5. **CSAT Trigger**: Changing status to "resolved" auto-inserts system message about LINE satisfaction survey
6. **RBAC**: Agent role sees only 即時客服 + AI與知識庫; admin sees all 5 menu items
7. **Real OpenAI Integration**: gpt-4o-mini sandbox with proper error handling
8. **Quick Replies**: ⚡ button with 3 preset messages
9. **CRM Tags**: Custom tags with color coding per contact
10. **3-second polling**: Real-time message updates
