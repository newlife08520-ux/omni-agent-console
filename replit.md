# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard) V2

## Overview
A commercial-grade omnichannel AI customer service dashboard focused on LINE channel integration. Built with Express + React (Vite) + Tailwind CSS + SQLite. All UI is 100% Traditional Chinese.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui components
- **Backend**: Express.js API server (port 5000)
- **Database**: SQLite via better-sqlite3 (file: omnichannel.db)
- **Auth**: Session-based with memorystore, password: admin123

## Project Structure
```
server/
  index.ts       - Express server setup with session middleware
  routes.ts      - All API endpoints (/api/*)
  storage.ts     - Storage interface for database operations
  db.ts          - SQLite database setup, schema, and mock data seeding
  vite.ts        - Vite dev server integration (DO NOT MODIFY)
  static.ts      - Static file serving for production

client/src/
  App.tsx              - Main app with auth guard, routing, sidebar layout
  pages/
    login.tsx          - Password login page (dark theme)
    chat.tsx           - Real-time chat with CRM panel (status, tags)
    settings.tsx       - API key management, test mode, test connection buttons
    knowledge.tsx      - System prompt, knowledge files, AI sandbox tab
    team.tsx           - Team member management page
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Dark sidebar navigation (bg-slate-900)
    ui/                - shadcn/ui components

shared/
  schema.ts            - TypeScript interfaces for all data models
```

## Database Schema
- **settings**: key-value store for API keys, system prompt, test mode
- **contacts**: LINE contacts with status (pending/processing/resolved), tags (JSON array), needs_human flag
- **messages**: Chat messages with sender_type (user/ai/admin)
- **knowledge_files**: Uploaded files (.txt, .pdf, .csv, .docx) for RAG (future)
- **team_members**: Team member list with name, email, role (super_admin/agent), status (online/offline)

## API Endpoints
- POST /api/auth/login - Login with password
- GET /api/auth/check - Check auth status
- POST /api/auth/logout - Logout
- GET/PUT /api/settings - Settings CRUD
- POST /api/settings/test-connection - Mock connection test (1s delay)
- GET /api/contacts - List contacts with last message preview
- GET /api/contacts/:id - Get single contact
- PUT /api/contacts/:id/human - Toggle human mode
- PUT /api/contacts/:id/status - Update contact status
- PUT /api/contacts/:id/tags - Update contact tags
- GET/POST /api/contacts/:id/messages - Messages CRUD
- POST /api/webhook/line - LINE webhook receiver with signature verification
- POST /api/ai/sandbox - AI sandbox mock reply
- GET/POST/DELETE /api/knowledge-files - Knowledge file management
- GET /api/team - List team members
- GET /api/order-status - Mock order status API

## Key Features (V2)
- Premium SaaS UI with dark sidebar (bg-slate-900) and light main area (bg-gray-50)
- Admin password authentication (default: admin123)
- Real-time chat with CRM panel (contact status dropdown, custom tags)
- Message input box for admin replies (shown as blue bubble "真人客服")
- AI sandbox for testing system prompt responses
- Test connection buttons for API keys (mock 1s loading)
- Knowledge file upload (.txt, .pdf, .csv, .docx)
- Team management page with 5 mock members
- LINE webhook with signature verification
- 3-second polling for real-time updates
- Contact avatars with color-coded initials
- Contact search functionality
- 5 mock contacts with multi-turn conversations seeded
