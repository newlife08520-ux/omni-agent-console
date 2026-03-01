export interface User {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "agent";
  created_at: string;
}

export interface Contact {
  id: number;
  platform: string;
  platform_user_id: string;
  display_name: string;
  avatar_url: string | null;
  needs_human: number;
  is_pinned: number;
  status: "pending" | "processing" | "resolved";
  tags: string;
  last_message_at: string | null;
  created_at: string;
}

export interface ContactWithPreview extends Contact {
  last_message?: string;
}

export interface Message {
  id: number;
  contact_id: number;
  platform: string;
  sender_type: "user" | "ai" | "admin" | "system";
  content: string;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

export interface KnowledgeFile {
  id: number;
  filename: string;
  original_name: string;
  size: number;
  created_at: string;
}

export interface TeamMember {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "agent";
  created_at: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  user?: { id: number; username: string; display_name: string; role: string };
}

export interface AnalyticsData {
  kpi: {
    todayInbound: number;
    aiInterceptRate: number;
    csatScore: number;
  };
  agentPerformance: { name: string; cases: number }[];
  intentDistribution: { name: string; value: number }[];
  aiInsights: {
    painPoints: string[];
    suggestions: string[];
  };
}
