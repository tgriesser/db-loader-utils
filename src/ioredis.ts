import type { Cluster, Redis } from 'ioredis'
import {
  RedisLoaderUtils,
  type RedisAdapter,
  type RedisLoaderUtilsOptions,
  type Reply,
} from './core/redis-loader-utils'

export * from './index'

/**
 * `MGET` and pipelines are used as-is, so on a `Cluster` the keys in one batch
 * must hash to the same slot (use `{hash tags}` in the pattern).
 */
export class IoredisAdapter implements RedisAdapter {
  constructor(private readonly redis: Redis | Cluster) {}

  mget(keys: readonly string[]) {
    return this.redis.mget(...keys)
  }

  hgetall(keys: readonly string[]) {
    return this.exec<Record<string, string>>(keys.map((k) => ['hgetall', k]))
  }

  hget(keys: readonly string[], field: string) {
    return this.exec<string | null>(keys.map((k) => ['hget', k, field]))
  }

  smembers(keys: readonly string[]) {
    return this.exec<string[]>(keys.map((k) => ['smembers', k]))
  }

  private async exec<T>(commands: string[][]): Promise<Reply<T>[]> {
    const results = await this.redis.pipeline(commands).exec()
    if (!results) throw new Error('Redis pipeline returned no results')
    return results.map(([err, result]) => err ?? (result as T))
  }
}

export class IoredisLoaderUtils<S> extends RedisLoaderUtils<S> {
  constructor(
    readonly redis: Redis | Cluster,
    options?: RedisLoaderUtilsOptions,
  ) {
    super(new IoredisAdapter(redis), options)
  }
}

export default IoredisLoaderUtils
