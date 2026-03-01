# 全通路 AI 客服中控台 (Omnichannel AI Agent Dashboard)

## Overview
A business-grade omnichannel AI customer service dashboard focused on LINE channel integration. Built with Express + React (Vite) + SQLite.

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
    login.tsx          - Password login page
    chat.tsx           - Real-time chat dashboard (main feature)
    settings.tsx       - API key management & test mode toggle
    knowledge.tsx      - System prompt & knowledge file management
    not-found.tsx      - 404 page
  components/
    app-sidebar.tsx    - Navigation sidebar
    ui/                - shadcn/ui components

shared/
  schema.ts            - TypeScript interfaces for Contact, Message, Setting, KnowledgeFile
```

## Database Schema
- **settings**: key-value store for API keys, system prompt, test mode
- **contacts**: LINE contacts with platform_user_id, needs_human flag
- **messages**: Chat messages with sender_type (user/ai/admin)
- **knowledge_files**: Uploaded .txt files for RAG (future)

## API Endpoints
- POST /api/auth/login - Login with password
- GET /api/auth/check - Check auth status
- GET/PUT /api/settings - Settings CRUD
- GET /api/contacts - List contacts
- GET/PUT /api/contacts/:id/human - Toggle human mode
- GET/POST /api/contacts/:id/messages - Messages CRUD
- POST /api/webhook/line - LINE webhook receiver
- GET/POST/DELETE /api/knowledge-files - Knowledge file management
- GET /api/order-status - Mock order status API

## Key Features
- Admin password authentication (default: admin123)
- Test mode toggle for safe development
- Real-time chat with 3s polling
- Human takeover detection (keywords: 找客服, 真人, etc.)
- Admin manual reply capability
- LINE webhook with signature verification
- Knowledge file upload (.txt)
- System prompt management
