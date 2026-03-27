# Shared UI

- `components/ui/*.tsx` — shadcn／Radix 封裝元件（與 `components.json` 的 **new-york** 風格一致）。
- `hooks/` — `use-toast`、`use-mobile`（影響 toast 與 responsive／sidebar 行為）。
- `lib/utils.ts` — `cn()` 等。
- `lib/chat-view-context.tsx` — 即時客服列表 **viewMode**（與側欄快捷連動）。
- `lib/brand-context.tsx` — 品牌／渠道選擇，影響全站 API queryKey。
- `lib/queryClient.ts` — fetch 包裝（**不含**任何 token；實際使用 `credentials: include`）。

> 若還原 import 路徑，應對應 `@/` → 本 pack 的相對結構或原 repo `client/src/`。
