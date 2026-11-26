import type { Queue } from "bullmq";

const DEFAULT_ENV_LOCK_TTL_MS = 120_000;

const RELEASE_LOCK_LUA =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

const RENEW_LOCK_LUA =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";

export interface RedisLockClient {
  get?(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
  pexpire?(key: string, ttlMs: number): Promise<unknown>;
}

export interface EnvLockHandle {
  key: string;
  release: () => Promise<void>;
}

/**
 * Acquire a per-environment mutual exclusion lock backed by Redis (`NX PX`)
 * with periodic lease renewal while the job is running and CAS release.
 *
 * Returns `null` when another worker currently holds the lock so the caller
 * can defer execution (e.g. via `job.moveToDelayed(...)`).
 */
export async function acquireEnvLock(
  queue: Pick<Queue, "client">,
  environmentId: number,
  ownerToken: string,
  ttlMs: number = DEFAULT_ENV_LOCK_TTL_MS,
): Promise<EnvLockHandle | null> {
  const redis = (await queue.client) as unknown as RedisLockClient;
  const key = `forge:env-lock:${environmentId}`;
  const acquired = await redis.set(key, ownerToken, "NX", "PX", ttlMs);
  if (!acquired) {
    return null;
  }

  const renewIntervalMs = Math.max(5_000, Math.floor(ttlMs / 3));
  const renewTimer = setInterval(() => {
    void redis.eval(RENEW_LOCK_LUA, 1, key, ownerToken, ttlMs).catch(() => {});
  }, renewIntervalMs);
  renewTimer.unref?.();

  let released = false;
  return {
    key,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(renewTimer);
      await redis
        .eval(RELEASE_LOCK_LUA, 1, key, ownerToken)
        .catch(() => {});
    },
  };
}

/**
 * Check whether an environment lock key is currently held in Redis.
 */
export async function isEnvLockHeld(
  queue: Pick<Queue, "client">,
  environmentId: number,
): Promise<boolean> {
  const redis = (await queue.client) as unknown as RedisLockClient;
  if (typeof redis?.get !== "function") {
    return false;
  }
  const value = await redis.get(`forge:env-lock:${environmentId}`);
  return value !== null;
}
