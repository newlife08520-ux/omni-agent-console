/**
 * 品牌與渠道的 Redis 持久化層（用於 Railway 等無狀態環境）。
 * 使用 key: omni:brands, omni:channels (JSON 陣列), omni:brands:nextId, omni:channels:nextId。
 */
import type { Brand, Channel, ChannelWithBrand } from "@shared/schema";

const KEY_BRANDS = "omni:brands";
const KEY_CHANNELS = "omni:channels";
const KEY_BRANDS_NEXT_ID = "omni:brands:nextId";
const KEY_CHANNELS_NEXT_ID = "omni:channels:nextId";

type RedisClient = { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<unknown>; incr: (k: string) => Promise<number>; del: (k: string) => Promise<unknown> };

function parseBrands(json: string | null): Brand[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Brand[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function parseChannels(json: string | null): Channel[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Channel[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function getBrands(client: RedisClient): Promise<Brand[]> {
  return client.get(KEY_BRANDS).then(parseBrands).then((arr) => arr.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")));
}

export function getBrand(client: RedisClient, id: number): Promise<Brand | undefined> {
  return getBrands(client).then((arr) => arr.find((b) => b.id === id));
}

export async function createBrand(
  client: RedisClient,
  name: string,
  slug: string,
  logoUrl?: string,
  description?: string,
  systemPrompt?: string,
  superlandingMerchantNo?: string,
  superlandingAccessKey?: string,
  returnFormUrl?: string,
  shoplineStoreDomain?: string,
  shoplineApiToken?: string
): Promise<Brand> {
  const id = await client.incr(KEY_BRANDS_NEXT_ID);
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const brand: Brand = {
    id,
    name,
    slug,
    logo_url: logoUrl ?? "",
    description: description ?? "",
    system_prompt: systemPrompt ?? "",
    superlanding_merchant_no: superlandingMerchantNo ?? "",
    superlanding_access_key: superlandingAccessKey ?? "",
    return_form_url: returnFormUrl ?? "",
    shopline_store_domain: shoplineStoreDomain ?? "",
    shopline_api_token: shoplineApiToken ?? "",
    created_at: now,
  };
  const brands = await getBrands(client);
  brands.push(brand);
  await client.set(KEY_BRANDS, JSON.stringify(brands));
  return brand;
}

export async function updateBrand(client: RedisClient, id: number, data: Partial<Omit<Brand, "id" | "created_at">>): Promise<boolean> {
  const brands = await getBrands(client);
  const idx = brands.findIndex((b) => b.id === id);
  if (idx < 0) return false;
  Object.assign(brands[idx], data);
  await client.set(KEY_BRANDS, JSON.stringify(brands));
  return true;
}

/** 將單一品牌同步進 Redis（品牌僅在 SQLite 存在時，更新後可寫入 Redis 以保持一致） */
export async function syncBrandToRedis(client: RedisClient, brand: Brand): Promise<void> {
  const brands = await getBrands(client);
  const idx = brands.findIndex((b) => b.id === brand.id);
  if (idx >= 0) {
    brands[idx] = { ...brand };
  } else {
    brands.push({ ...brand });
  }
  brands.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  await client.set(KEY_BRANDS, JSON.stringify(brands));
}

export async function deleteBrand(client: RedisClient, id: number): Promise<boolean> {
  const [brands, channels] = await Promise.all([getBrands(client), getChannels(client)]);
  const newBrands = brands.filter((b) => b.id !== id);
  const newChannels = channels.filter((c) => c.brand_id !== id);
  if (newBrands.length === brands.length) return false;
  await Promise.all([client.set(KEY_BRANDS, JSON.stringify(newBrands)), client.set(KEY_CHANNELS, JSON.stringify(newChannels))]);
  return true;
}

export async function getChannels(client: RedisClient): Promise<Channel[]> {
  return client.get(KEY_CHANNELS).then(parseChannels).then((arr) => arr.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")));
}

export async function getChannelsWithBrand(client: RedisClient): Promise<ChannelWithBrand[]> {
  const [channels, brands] = await Promise.all([getChannels(client), getBrands(client)]);
  const brandMap = new Map(brands.map((b) => [b.id, b]));
  return channels.map((c) => {
    const b = brandMap.get(c.brand_id);
    return { ...c, brand_name: b?.name, brand_slug: b?.slug };
  });
}

export async function getChannelsByBrand(client: RedisClient, brandId: number): Promise<Channel[]> {
  const channels = await getChannels(client);
  return channels.filter((c) => c.brand_id === brandId);
}

export async function getChannel(client: RedisClient, id: number): Promise<Channel | undefined> {
  const channels = await getChannels(client);
  return channels.find((c) => c.id === id);
}

export async function getChannelByBotId(client: RedisClient, botId: string): Promise<ChannelWithBrand | undefined> {
  const list = await getChannelsWithBrand(client);
  return list.find((c) => c.bot_id === botId && c.is_active === 1);
}

export async function createChannel(
  client: RedisClient,
  brandId: number,
  platform: string,
  channelName: string,
  botId?: string,
  accessToken?: string,
  channelSecret?: string
): Promise<Channel> {
  const id = await client.incr(KEY_CHANNELS_NEXT_ID);
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const channel: Channel = {
    id,
    brand_id: brandId,
    platform: platform as "line" | "messenger",
    channel_name: channelName,
    bot_id: botId ?? "",
    access_token: accessToken ?? "",
    channel_secret: channelSecret ?? "",
    is_active: 1,
    is_ai_enabled: 0,
    created_at: now,
  };
  const channels = await getChannels(client);
  channels.push(channel);
  await client.set(KEY_CHANNELS, JSON.stringify(channels));
  return channel;
}

export async function updateChannel(client: RedisClient, id: number, data: Partial<Omit<Channel, "id" | "created_at">>): Promise<boolean> {
  const channels = await getChannels(client);
  const idx = channels.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  Object.assign(channels[idx], data);
  await client.set(KEY_CHANNELS, JSON.stringify(channels));
  return true;
}

export async function deleteChannel(client: RedisClient, id: number): Promise<boolean> {
  const channels = await getChannels(client);
  const newChannels = channels.filter((c) => c.id !== id);
  if (newChannels.length === channels.length) return false;
  await client.set(KEY_CHANNELS, JSON.stringify(newChannels));
  return true;
}

/** 初始化 nextId：若 key 不存在則設為 max(id)+1，避免覆寫既有資料時 id 衝突 */
export async function ensureNextIds(client: RedisClient): Promise<void> {
  const [brands, channels] = await Promise.all([getBrands(client), getChannels(client)]);
  const maxBrandId = brands.length ? Math.max(...brands.map((b) => b.id)) : 0;
  const maxChannelId = channels.length ? Math.max(...channels.map((c) => c.id)) : 0;
  const [b, c] = await Promise.all([client.get(KEY_BRANDS_NEXT_ID), client.get(KEY_CHANNELS_NEXT_ID)]);
  if (b === null) await client.set(KEY_BRANDS_NEXT_ID, String(maxBrandId + 1));
  if (c === null) await client.set(KEY_CHANNELS_NEXT_ID, String(maxChannelId + 1));
}

/** 將 Redis 中的品牌與渠道同步到 SQLite，供 JOIN 與讀取使用（啟動時呼叫一次） */
export async function syncRedisToSqlite(
  client: RedisClient,
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => { lastInsertRowid: bigint }; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } }
): Promise<void> {
  const [brands, channels] = await Promise.all([getBrands(client), getChannels(client)]);
  if (brands.length === 0 && channels.length === 0) return;

  const insBrand = db.prepare(`
    INSERT OR REPLACE INTO brands (id, name, slug, logo_url, description, system_prompt, superlanding_merchant_no, superlanding_access_key, return_form_url, shopline_store_domain, shopline_api_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insChannel = db.prepare(`
    INSERT OR REPLACE INTO channels (id, brand_id, platform, channel_name, bot_id, access_token, channel_secret, is_active, is_ai_enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const b of brands) {
    insBrand.run(b.id, b.name, b.slug, b.logo_url ?? "", b.description ?? "", b.system_prompt ?? "", b.superlanding_merchant_no ?? "", b.superlanding_access_key ?? "", b.return_form_url ?? "", b.shopline_store_domain ?? "", b.shopline_api_token ?? "", b.created_at ?? "");
  }
  for (const ch of channels) {
    insChannel.run(ch.id, ch.brand_id, ch.platform, ch.channel_name, ch.bot_id ?? "", ch.access_token ?? "", ch.channel_secret ?? "", ch.is_active ?? 1, ch.is_ai_enabled ?? 0, ch.created_at ?? "");
  }
  await ensureNextIds(client);
}
