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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="brands-channels-page">
      <div>
        <h1 className="text-xl font-bold text-stone-800">品牌與渠道</h1>
        <p className="text-sm text-stone-500 mt-1">管理品牌與渠道（LINE / Facebook）的連線設定</p>
      </div>

      {isSuperAdmin ? (
        <BrandChannelManager isSuperAdmin={isSuperAdmin} />
      ) : (
        <p className="text-sm text-stone-500">僅管理員可管理品牌與渠道</p>
      )}
    </div>
  );
}