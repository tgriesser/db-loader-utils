import DataLoader, { type BatchLoadFn } from 'dataloader'
import type { Adapter, Row } from './adapter'
import { NotFoundError } from './errors'
import { bindScope } from './scope'
import type {
  BoundScope,
  BuilderFor,
  Column,
  Key,
  KeyOf,
  DBLoaderUtilsOptions,
  QueryBuilderKind,
  ScopeDef,
  ScopeOptions,
  Table,
} from './types'

const DEFAULT_MAX_BATCH_SIZE = 5000

export class DBLoaderUtils<DB, QB extends QueryBuilderKind<DB>> {
  readonly loaders = new Map<string, DataLoader<any, any, any>>()
  private readonly scopes = new Map<string, ScopeDef<any, any>>()

  constructor(
    protected readonly adapter: Adapter,
    protected readonly options: DBLoaderUtilsOptions = {},
  ) {}

  /** Get-or-create a loader by key. Custom loaders registered here are cleared/disposed with the rest. */
  loader<K, V, C = K>(
    key: string,
    batchFn: BatchLoadFn<K, V>,
    options?: DataLoader.Options<K, V, C>,
  ): DataLoader<K, V, C> {
    let loader = this.loaders.get(key) as DataLoader<K, V, C> | undefined
    if (!loader) {
      const cache = options?.cache ?? this.options.cache ?? true
      loader = new DataLoader<K, V, C>(batchFn, {
        maxBatchSize: this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
        cache,
        name: cache ? key : `${key}:nocache`,
        ...options,
      })
      this.loaders.set(key, loader)
    }
    return loader
  }

  clearAll(): this {
    for (const loader of this.loaders.values()) loader.clearAll()
    return this
  }

  dispose(): void {
    this.clearAll()
    this.loaders.clear()
    this.scopes.clear()
  }

  byColumn<T extends Table<DB>, C extends Column<DB, T>>(
    table: T,
    column: C,
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, DB[T] | null> {
    const scope = this.scope([table], opts)
    return this.loader(this.key('byColumn', [table, column], scope), async (keys) => {
      const rows = await this.adapter.select({
        table,
        column,
        keys: uniq(keys),
        scope: scope?.apply,
      })
      const byKey = indexBy(rows, column)
      return keys.map((k) => (byKey.get(String(k)) as DB[T] | undefined) ?? null)
    })
  }

  byColumnOrThrow<T extends Table<DB>, C extends Column<DB, T>>(
    table: T,
    column: C,
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, DB[T]> {
    const scope = this.scope([table], opts)
    return this.loader(this.key('byColumnOrThrow', [table, column], scope), async (keys) => {
      const rows = await this.adapter.select({
        table,
        column,
        keys: uniq(keys),
        scope: scope?.apply,
      })
      const byKey = indexBy(rows, column)
      return keys.map(
        (k): DB[T] | Error =>
          (byKey.get(String(k)) as DB[T] | undefined) ?? new NotFoundError(table, column, k),
      )
    })
  }

  byColumnPick<T extends Table<DB>, C extends Column<DB, T>, P extends Column<DB, T>>(
    table: T,
    column: C,
    columns: readonly P[],
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, Pick<DB[T], C | P> | null> {
    const scope = this.scope([table], opts)
    return this.loader(
      this.key('byColumnPick', [table, column, ...columns], scope),
      async (keys) => {
        const rows = await this.adapter.select({
          table,
          column,
          keys: uniq(keys),
          columns: uniq([column, ...columns]),
          scope: scope?.apply,
        })
        const byKey = indexBy(rows, column)
        return keys.map((k) => (byKey.get(String(k)) as Pick<DB[T], C | P> | undefined) ?? null)
      },
    )
  }

  byColumnSingle<T extends Table<DB>, C extends Column<DB, T>, S extends Column<DB, T>>(
    table: T,
    column: C,
    single: S,
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, DB[T][S] | null> {
    const scope = this.scope([table], opts)
    return this.loader(this.key('byColumnSingle', [table, column, single], scope), async (keys) => {
      const rows = await this.adapter.select({
        table,
        column,
        keys: uniq(keys),
        columns: uniq([column, single]),
        scope: scope?.apply,
      })
      const byKey = indexBy(rows, column)
      return keys.map((k) => (byKey.get(String(k))?.[single] as DB[T][S] | undefined) ?? null)
    })
  }

  manyByColumn<T extends Table<DB>, C extends Column<DB, T>>(
    table: T,
    column: C,
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, DB[T][]> {
    const scope = this.scope([table], opts)
    return this.loader(this.key('manyByColumn', [table, column], scope), async (keys) => {
      const rows = await this.adapter.select({
        table,
        column,
        keys: uniq(keys),
        scope: scope?.apply,
      })
      const byKey = groupBy(rows, column)
      return keys.map((k) => (byKey.get(String(k)) as DB[T][] | undefined) ?? [])
    })
  }

  manyByColumnPick<T extends Table<DB>, C extends Column<DB, T>, P extends Column<DB, T>>(
    table: T,
    column: C,
    columns: readonly P[],
    opts?: ScopeOptions<BuilderFor<QB, T>> & { distinct?: boolean },
  ): DataLoader<KeyOf<DB[T], C>, Pick<DB[T], C | P>[]> {
    const method = opts?.distinct ? 'manyDistinctByColumnPick' : 'manyByColumnPick'
    const scope = this.scope([table], opts)
    return this.loader(this.key(method, [table, column, ...columns], scope), async (keys) => {
      const rows = await this.adapter.select({
        table,
        column,
        keys: uniq(keys),
        columns: uniq([column, ...columns]),
        distinct: opts?.distinct,
        scope: scope?.apply,
      })
      const byKey = groupBy(rows, column)
      return keys.map((k) => (byKey.get(String(k)) as Pick<DB[T], C | P>[] | undefined) ?? [])
    })
  }

  /**
   * Rows of `table` reachable through `joinTable`, keyed by `joinTable.constraint`.
   * e.g. `manyByColumnJoin(['posts', 'user_id', 'users', 'id'], 'org_id')` loads
   * an org's posts via its users. The constraint column is included on each row.
   */
  manyByColumnJoin<
    T extends Table<DB>,
    TC extends Column<DB, T>,
    J extends Table<DB>,
    JC extends Column<DB, J>,
    K extends Column<DB, J>,
  >(
    source: readonly [table: T, tableColumn: TC, joinTable: J, joinColumn: JC],
    constraint: K,
    opts?: ScopeOptions<BuilderFor<QB, T | J>>,
  ): DataLoader<KeyOf<DB[J], K>, Array<DB[T] & Pick<DB[J], K>>> {
    const [table, tableColumn, joinTable, joinColumn] = source
    const scope = this.scope([table, joinTable], opts)
    return this.loader(
      this.key('manyByColumnJoin', [...source, constraint], scope),
      async (keys) => {
        const rows = await this.adapter.selectJoin({
          table,
          joinTable,
          on: [tableColumn, joinColumn],
          column: constraint,
          keys: uniq(keys),
          scope: scope?.apply,
        })
        const byKey = groupBy(rows, constraint)
        return keys.map(
          (k) => (byKey.get(String(k)) as Array<DB[T] & Pick<DB[J], K>> | undefined) ?? [],
        )
      },
    )
  }

  countByColumn<T extends Table<DB>, C extends Column<DB, T>>(
    table: T,
    column: C,
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, number> {
    const scope = this.scope([table], opts)
    return this.loader(this.key('countByColumn', [table, column], scope), async (keys) => {
      const rows = await this.adapter.aggregate({
        table,
        column,
        keys: uniq(keys),
        sums: [],
        count: true,
        scope: scope?.apply,
      })
      const byKey = indexBy(rows, column)
      return keys.map((k) => Number(byKey.get(String(k))?.count ?? 0))
    })
  }

  sumByColumn<T extends Table<DB>, C extends Column<DB, T>, S extends Column<DB, T>>(
    table: T,
    column: C,
    columns: readonly S[],
    opts?: ScopeOptions<BuilderFor<QB, T>>,
  ): DataLoader<KeyOf<DB[T], C>, Record<S, number>> {
    const scope = this.scope([table], opts)
    return this.loader(
      this.key('sumByColumn', [table, column, ...columns], scope),
      async (keys) => {
        const rows = await this.adapter.aggregate({
          table,
          column,
          keys: uniq(keys),
          sums: columns,
          count: false,
          scope: scope?.apply,
        })
        const byKey = indexBy(rows, column)
        return keys.map((k) => {
          const row = byKey.get(String(k))
          return Object.fromEntries(columns.map((c) => [c, Number(row?.[c] ?? 0)])) as Record<
            S,
            number
          >
        })
      },
    )
  }

  private scope(tables: readonly string[], opts?: ScopeOptions<any>): BoundScope<any> | undefined {
    if (!opts?.scope) return undefined
    const bound = bindScope(opts.scope)
    for (const t of bound.def.tables) {
      if (!tables.includes(t)) {
        throw new Error(
          `Scope "${bound.def.name}" is defined for "${t}" but this loader queries ${tables.join(', ')}`,
        )
      }
    }
    return bound
  }

  private key(method: string, parts: readonly string[], scope?: BoundScope<any>): string {
    const base = `${method}:${parts.join('.')}`
    if (!scope) return base
    const key = `${base}#${scope.key}`
    const registered = this.scopes.get(key)
    if (registered && registered !== scope.def) {
      throw new Error(
        `Scope "${scope.def.name}" is already registered for ${base} with a different definition`,
      )
    }
    this.scopes.set(key, scope.def)
    return key
  }
}

function uniq<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items))
}

function indexBy(rows: Row[], column: string): Map<string, Row> {
  const map = new Map<string, Row>()
  for (const row of rows) map.set(String(row[column]), row)
  return map
}

function groupBy(rows: Row[], column: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>()
  for (const row of rows) {
    const key = String(row[column])
    const group = map.get(key)
    if (group) group.push(row)
    else map.set(key, [row])
  }
  return map
}

export type { Key }
