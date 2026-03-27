import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/** 最外層 ErrorBoundary：捕捉 createRoot 直屬子樹錯誤，避免白屏並產出可辨識 log 供根因定位 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: unknown }
> {
  state = { hasError: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[WHITE_SCREEN_ROOT] 錯誤發生在 App 最外層子樹，便於根因定位:", error);
    console.error("[WHITE_SCREEN_ROOT] componentStack:", info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
      return (
        <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 560 }}>
          <h2 style={{ color: "#b91c1c" }}>頁面載入錯誤</h2>
          <p style={{ color: "#57534e", fontSize: 14 }}>{msg}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}
          >
            重新整理
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (typeof import.meta !== "undefined" && import.meta.env?.PROD && !rootEl) {
  console.warn("[main] PRODUCTION: #root missing, creating container. Possible wrong HTML or base path.");
}
if (!rootEl) {
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  createRoot(el).render(
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
} else {
  createRoot(rootEl).render(
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}
