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
    - **轉接真人客服 (Explicit Handoff)**: AI honestly identifies itself and asks if the customer wants to be transferred. Backend still sets needs_human=1 to pause AI and alert agents. Sandbox shows debug info (transfer reason + tool call log) as a separate red warning bubble — debug info is NOT embedded in the AI reply text.
    - **一頁商店 (Super Landing) API Integration**: Triple-mode order lookup with product matching, fuzzy search, and dynamic catalog injection for AI queries. Cross-brand fallback: when primary brand returns no results, automatically tries all other brands with configured API credentials. Knowledge CSV product→page_id mapping used as fallback when SuperLanding page name fuzzy matching fails.
    - **Real-time Chat**: Features include CRM panel, order lookup, VIP badges, quick replies, and image upload with AI analysis.
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
- **LINE Messaging API**: Used for handling LINE webhooks, sending messages, and content retrieval (images, videos).
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