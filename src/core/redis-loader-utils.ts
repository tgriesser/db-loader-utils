import type DataLoader from 'dataloader'
import { LoaderRegistry, type LoaderRegistryOptions } from './loader-registry'
import type { Key } from './types'

/** An `Error` entry rejects only that key, matching DataLoader's batch contract. */
export type Reply<T> = T | Error

export interface RedisAdapter {
  mget(keys: readonly string[]): Promise<Reply<string | null>[]>
  /** `{}` for a missing hash, as Redis returns it. */
  hgetall(keys: readonly string[]): Promise<Reply<Record<string, string>>[]>
  hget(keys: readonly string[], field: string): Promise<Reply<string | null>[]>
  smembers(keys: readonly string[]): Promise<Reply<string[]>[]>
}

/** Schema keys are key patterns with one `{placeholder}`, e.g. `'user:{id}'`. */
export type Pattern<S> = keyof S & `${string}{${string}}${string}`

export interface RedisLoaderUtilsOptions extends LoaderRegistryOptions {
  /** Decodes values loaded with `get`. Default `JSON.parse`. */
  decode?: (raw: string, key: string) => unknown
}

const PLACEHOLDER = /\{[^}]*\}/

export class RedisLoaderUtils<S> extends LoaderRegistry {
  constructor(
    readonly adapter: RedisAdapter,
    protected readonly options: RedisLoaderUtilsOptions = {},
  ) {
    super(options)
  }

  key<P extends Pattern<S>>(pattern: P, id: Key): string {
    return pattern.replace(PLACEHOLDER, String(id))
  }

  /** String values via `MGET`, decoded with `options.decode`. */
  get<P extends Pattern<S>>(pattern: P): DataLoader<Key, S[P] | null> {
    const decode = this.options.decode ?? ((raw: string) => JSON.parse(raw))
    return this.loader(`get:${pattern}`, async (ids) => {
      const replies = await this.fetch(pattern, ids, (keys) => this.adapter.mget(keys))
      return replies.map(([key, reply]) => {
        if (reply == null || reply instanceof Error) return reply ?? null
        try {
          return decode(reply, key) as S[P]
        } catch (e) {
          return toError(e)
        }
      })
    })
  }

  /** Whole hashes via pipelined `HGETALL`; a missing hash loads as `null`. */
  hash<P extends Pattern<S>>(pattern: P): DataLoader<Key, S[P] | null> {
    return this.loader(`hash:${pattern}`, async (ids) => {
      const replies = await this.fetch(pattern, ids, (keys) => this.adapter.hgetall(keys))
      return replies.map(([, reply]) =>
        reply instanceof Error || Object.keys(reply).length ? (reply as S[P] | Error) : null,
      )
    })
  }

  /** One hash field via pipelined `HGET`. */
  hashField<P extends Pattern<S>, F extends keyof S[P] & string>(
    pattern: P,
    field: F,
  ): DataLoader<Key, S[P][F] | null> {
    return this.loader(`hget:${pattern}.${field}`, async (ids) => {
      const replies = await this.fetch(pattern, ids, (keys) => this.adapter.hget(keys, field))
      return replies.map(([, reply]) => reply as S[P][F] | Error | null)
    })
  }

  /** Set members via pipelined `SMEMBERS`; a missing set loads as `[]`. */
  members<P extends Pattern<S>>(pattern: P): DataLoader<Key, string[]> {
    return this.loader(`smembers:${pattern}`, async (ids) => {
      const replies = await this.fetch(pattern, ids, (keys) => this.adapter.smembers(keys))
      return replies.map(([, reply]) => reply)
    })
  }

  // Fetches each distinct key once (ids may repeat when `cache` is off, and
  // `1` and `'1'` build the same key) and maps replies back per id.
  private async fetch<T>(
    pattern: Pattern<S>,
    ids: readonly Key[],
    fetch: (keys: string[]) => Promise<Reply<T>[]>,
  ): Promise<Array<[key: string, reply: Reply<T>]>> {
    const keys = Array.from(new Set(ids.map((id) => this.key(pattern, id))))
    const replies = await fetch(keys)
    const byKey = new Map(keys.map((key, i) => [key, replies[i]!]))
    return ids.map((id) => {
      const key = this.key(pattern, id)
      return [key, byKey.get(key)!]
    })
  }
}

export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}
