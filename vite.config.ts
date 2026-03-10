import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // React 核心與路由／狀態：單一巨大 chunk 易導致 HTTP/2 傳輸逾時
            if (
              id.includes("react-dom") ||
              id.includes("@tanstack/react-query") ||
              id.includes("wouter")
            ) {
              return "vendor-react";
            }
            if (
              id.includes("node_modules/react/") &&
              !id.includes("node_modules/react-")
            ) {
              return "vendor-react";
            }
            if (id.includes("scheduler/")) return "vendor-react";
            // 大型 UI／圖表庫
            if (id.includes("lucide-react") || id.includes("recharts")) {
              return "vendor-ui";
            }
            // Radix UI 組件群
            if (id.includes("@radix-ui/")) {
              return "vendor-radix";
            }
            // 表單與驗證
            if (
              id.includes("react-hook-form") ||
              id.includes("@hookform/") ||
              id.includes("zod")
            ) {
              return "vendor-forms";
            }
            // 動畫與其餘較大依賴
            if (
              id.includes("framer-motion") ||
              id.includes("date-fns") ||
              id.includes("xlsx") ||
              id.includes("jszip")
            ) {
              return "vendor-misc";
            }
            // 其餘 node_modules 統一為 vendor
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
