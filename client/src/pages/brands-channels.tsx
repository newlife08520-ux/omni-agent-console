import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { BrandChannelManager } from "@/components/brand-channel-manager";

export default function BrandsChannelsPage() {
  const { data: authData } = useQuery<{ authenticated?: boolean; user?: { role: string } }>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const user = authData?.user;
  const isSuperAdmin = user?.role === "super_admin";
  const isMarketingManager = user?.role === "marketing_manager";
  const canViewBrands = isSuperAdmin || isMarketingManager;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="brands-channels-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800">品牌與渠道</h1>
        <p className="text-sm text-stone-500 mt-1">管理品牌與渠道（LINE / Facebook）的連線設定</p>
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
          若 LINE 訊息只出現在即時客服的「全部」、在個別品牌下看不到，請將該 LINE 渠道的 Bot ID 改為 Railway 日誌中的 <code className="bg-amber-100 px-1 rounded">[WEBHOOK] destination:</code> 值（勿填 U 開頭的 User ID）。
        </p>
      </div>

      {canViewBrands ? (
        <BrandChannelManager isSuperAdmin={isSuperAdmin} readOnly={isMarketingManager} />
      ) : (
        <p className="text-sm text-stone-500">僅管理員可管理品牌與渠道</p>
      )}
    </div>
  );
}