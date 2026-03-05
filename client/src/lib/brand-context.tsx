import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "./queryClient";
import type { Brand, Channel } from "@shared/schema";

interface BrandContextType {
  brands: Brand[];
  brandsLoading: boolean;
  selectedBrandId: number | null;
  setSelectedBrandId: (id: number | null) => void;
  selectedBrand: Brand | undefined;
  channels: Channel[];
  channelsLoading: boolean;
}

const BrandContext = createContext<BrandContextType>({
  brands: [],
  brandsLoading: true,
  selectedBrandId: null,
  setSelectedBrandId: () => {},
  selectedBrand: undefined,
  channels: [],
  channelsLoading: false,
});

export function BrandProvider({ children }: { children: React.ReactNode }) {
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);

  const { data: brandsRaw, isLoading: brandsLoading } = useQuery<Brand[] | null>({
    queryKey: ["/api/brands"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });
  const brands = Array.isArray(brandsRaw) ? brandsRaw : [];

  const { data: channelsRaw, isLoading: channelsLoading } = useQuery<Channel[]>({
    queryKey: ["/api/brands", selectedBrandId, "channels"],
    queryFn: async () => {
      if (!selectedBrandId) return [];
      const res = await fetch(`/api/brands/${selectedBrandId}/channels`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: !!selectedBrandId,
  });
  const channels = Array.isArray(channelsRaw) ? channelsRaw : [];

  const handleSetBrand = useCallback((id: number | null) => {
    setSelectedBrandId(id);
  }, []);

  useEffect(() => {
    if (!brandsLoading && brands.length > 0 && selectedBrandId === null) {
      setSelectedBrandId(brands[0].id);
    }
  }, [brandsLoading, brands, selectedBrandId]);

  const selectedBrand = brands.find((b) => b.id === selectedBrandId);

  return (
    <BrandContext.Provider
      value={{
        brands,
        brandsLoading,
        selectedBrandId,
        setSelectedBrandId: handleSetBrand,
        selectedBrand,
        channels,
        channelsLoading,
      }}
    >
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand() {
  return useContext(BrandContext);
}
