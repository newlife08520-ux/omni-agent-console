import { createContext, useContext, useState, useCallback, useEffect } from "react";

export type ViewMode = "all" | "my" | "pending" | "high_risk" | "unassigned" | "tracking" | "overdue";

const VALID_VIEWS: ViewMode[] = ["all", "my", "pending", "high_risk", "unassigned", "tracking", "overdue"];

function viewFromHash(): ViewMode {
  if (typeof window === "undefined") return "all";
  const m = window.location.hash.match(/view=(my|pending|high_risk|unassigned|all|tracking|overdue)/);
  return (m && VALID_VIEWS.includes(m[1] as ViewMode) ? m[1] : "all") as ViewMode;
}

interface ChatViewContextType {
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
}

const DEFAULT_CHAT_VIEW: ChatViewContextType = {
  viewMode: "all",
  setViewMode: () => {},
};

const ChatViewContext = createContext<ChatViewContextType>(DEFAULT_CHAT_VIEW);

export function ChatViewProvider({ children }: { children: React.ReactNode }) {
  const [viewMode, setViewModeState] = useState<ViewMode>(viewFromHash);

  const setViewMode = useCallback((v: ViewMode) => {
    setViewModeState(v);
    const hash = `view=${v}`;
    if (window.location.hash !== hash) {
      try {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${hash}`);
      } catch {
        window.location.hash = hash;
      }
    }
  }, []);

  useEffect(() => {
    const sync = () => setViewModeState(viewFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <ChatViewContext.Provider value={{ viewMode, setViewMode }}>
      {children}
    </ChatViewContext.Provider>
  );
}

export function useChatView() {
  const ctx = useContext(ChatViewContext);
  return ctx ?? DEFAULT_CHAT_VIEW;
}
