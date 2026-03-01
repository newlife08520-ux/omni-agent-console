# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard) V3

## Overview
A commercial-grade omnichannel AI customer service dashboard focused on LINE channel integration. Built with Express + React (Vite) + Tailwind CSS + SQLite. All UI is 100% Traditional Chinese with warm cozy SaaS design.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui components
- **Backend**: Express.js API server (port 5000)
- **Database**: SQLite via better-sqlite3 (file: omnichannel.db)
- **Auth**: Session-based with RBAC (admin/agent roles), SHA-256 password hashing
- **AI**: OpenAI API integration (gpt-4o-mini) for sandbox testing

## Test Accounts
- **admin** / admin123 → role: admin (full access)
- **agent** / agent123 → role: agent (chat + knowledge only)

## Project Structure
```
server/
  index.ts       - Express server setup with session middleware
  routes.ts      - All API endpoints (/api/*)
  storage.ts     - Storage interface for database operations
  db.ts          - SQLite database setup, schema, users table, and mock data seeding
  vite.ts        - Vite dev server integration (DO NOT MODIFY)
  static.ts      - Static file serving for production

client/src/
  App.tsx              - Main app with auth guard, RBAC, routing
  pages/
    login.tsx          - Username/password login page (warm theme)
    chat.tsx           - Real-time chat with CRM panel, quick replies
    settings.tsx       - API key management, test mode (admin only)
    knowledge.tsx      - System prompt, knowledge files, AI sandbox (OpenAI)
    team.tsx           - Team member management (admin only)
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Dark warm sidebar (bg-stone-800) with role-based menu filtering

shared/
  schema.ts            - TypeScript interfaces for all data models
```

## Database Schema
- **users**: username, password_hash, role (admin/agent)
- **settings**: key-value store for API keys, system prompt, test mode
- **contacts**: LINE contacts with status (pending/processing/resolved), tags (JSON), needs_human flag
- **messages**: Chat messages with sender_type (user/ai/admin)
- **knowledge_files**: Uploaded files (.txt, .pdf, .csv, .docx)
- **team_members**: Team members with name, email, role, online/offline status

## API Endpoints
- POST /api/auth/login - Login with username/password
- GET /api/auth/check - Check auth status (returns user info + role)
- POST /api/auth/logout - Logout
- GET/PUT /api/settings - Settings CRUD (PUT: admin only)
- POST /api/settings/test-connection - Mock connection test (admin only)
- GET /api/contacts - List contacts with preview
- PUT /api/contacts/:id/status - Update contact status
- PUT /api/contacts/:id/tags - Update contact tags
- PUT /api/contacts/:id/human - Toggle human mode
- GET/POST /api/contacts/:id/messages - Messages CRUD
- POST /api/webhook/line - LINE webhook with signature verification
- POST /api/sandbox/chat - Real OpenAI API sandbox (reads key from settings)
- POST /api/ai/sandbox - Mock AI sandbox (fallback)
- GET/POST/DELETE /api/knowledge-files - Knowledge file management
- GET /api/team - List team members (admin only)

## Key Features (V3)
- Warm cozy SaaS UI (bg-[#faf9f5] cream, bg-stone-800 sidebar, emerald-600 accents)
- RBAC: admin sees all pages, agent sees only chat + knowledge
- Real OpenAI API integration for AI sandbox (gpt-4o-mini)
- Quick replies (⚡) with 3 preset messages in chat input
- CRM panel: contact status dropdown, custom tags
- Admin message bubbles (amber-600 warm color)
- Knowledge file upload (.txt, .pdf, .csv, .docx) with drag-and-drop
- Test connection buttons for API keys
- LINE webhook with signature verification
- 3-second polling for real-time updates
- 5 mock contacts, 5 mock team members seeded
