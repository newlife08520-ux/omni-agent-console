/**
 * 共用 Redis 連線，供 session store 與 brands/channels 持久化使用。
 * 由 index.ts 在建立 Redis 連線後呼叫 setRedisClient() 注入。
 */
export type RedisClientLike = { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<unknown>; incr: (k: string) => Promise<number>; del: (k: string) => Promise<unknown> };

let redisClient: RedisClientLike | null = null;

export function setRedisClient(client: RedisClientLike | null): void {
  redisClient = client;
}

export function getRedisClient(): RedisClientLike | null {
  return redisClient;
}
