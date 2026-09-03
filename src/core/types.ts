export type Key = string | number

export type Table<DB> = keyof DB & string
export type Column<DB, T extends Table<DB>> = keyof DB[T] & string
export type KeyOf<Row, C extends keyof Row> = Extract<Row[C], Key>

/**
 * Lets an adapter describe its query builder type as a function of the table
 * being queried, without higher-kinded types: `BuilderFor<Kind, 'users'>`
 * re-binds `this['tables']` inside the adapter's `builder` declaration.
 */
export interface QueryBuilderKind<DB> {
  readonly tables: keyof DB
  readonly builder: unknown
}

export type BuilderFor<K extends QueryBuilderKind<any>, T> = (K & {
  readonly tables: T
})['builder']

/**
 * A scope created once with `defineScope`. Scopes change what a loader returns,
 * so each is registered under its name and the registry refuses a second,
 * different definition for the same name. Parameters are passed through
 * `with(...)` so they become part of the loader key rather than a closure.
 */
export interface ScopeDef<QB, Args extends unknown[] = []> {
  readonly name: string
  readonly tables: readonly string[]
  readonly scope: (qb: QB, ...args: Args) => QB
  with(...args: Args): BoundScope<QB>
}

export interface BoundScope<QB> {
  readonly def: ScopeDef<QB, any>
  readonly key: string
  readonly apply: (qb: QB) => QB
}

export type ScopeArg<QB> = ScopeDef<QB, []> | BoundScope<QB>

export interface ScopeOptions<QB> {
  scope?: ScopeArg<QB>
}

export interface DBLoaderUtilsOptions {
  /** Upper bound on keys per batch, so `IN (...)` lists stay a sane size. Default 5000. */
  maxBatchSize?: number
  /** Passed to every DataLoader. `false` keeps batching but drops per-key memoization. */
  cache?: boolean
}
