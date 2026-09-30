import type { ScopeArg } from '../types'

/** The row shapes of one table: what a select returns, and what insert / update accept. */
export interface TableTypes {
  select: object
  insert: object
  update: object
}

export type TablesShape = { [table: string]: TableTypes }

export type TableName<Tables> = keyof Tables & string
export type SelectRow<Tables, T extends keyof Tables> = Tables[T] extends TableTypes
  ? Tables[T]['select']
  : never
export type InsertRow<Tables, T extends keyof Tables> = Tables[T] extends TableTypes
  ? Tables[T]['insert']
  : never
export type UpdateRow<Tables, T extends keyof Tables> = Tables[T] extends TableTypes
  ? Tables[T]['update']
  : never
export type ColumnOf<Row> = keyof Row & string

/**
 * Per-adapter types, re-bound per table the same way `QueryBuilderKind` is:
 * `ReadScopeFor<Kind, 'users'>` re-binds `this['tables']`.
 */
export interface TableKind {
  readonly tables: unknown
  /** The select builder a read scope receives (`findAllBy`, `countBy`, ...). */
  readonly readBuilder: unknown
  /** Narrows the rows an update / delete / conflict-merge touches. */
  readonly writeScope: unknown
  /** A builder expression usable as a column value in an update (`knex.raw`, kysely `sql`). */
  readonly expression: unknown
  /** What `transaction` / `withTransaction` bind to. */
  readonly executor: unknown
}

type Bind<K extends TableKind, T> = K & { readonly tables: T }
type ReadBuilderFor<K extends TableKind, T> = Bind<K, T>['readBuilder']
/** A plain function, or a scope made with the loader `defineScope`. */
export type ReadScopeFor<K extends TableKind, T> =
  ((qb: ReadBuilderFor<K, T>) => ReadBuilderFor<K, T>) | ScopeArg<ReadBuilderFor<K, T>>
export type WriteScopeFor<K extends TableKind, T> = Bind<K, T>['writeScope']

/** Equality filter; `null` matches `IS NULL`, `undefined` is rejected. */
export type Where<Row> = { [C in keyof Row]?: Row[C] | null }

export type SetValues<Row, Expr> = { [C in keyof Row]?: Row[C] | Expr }

export type Returning<Row> = '*' | readonly ColumnOf<Row>[]

export type ReturnedRow<Row, R> = R extends '*'
  ? Row
  : R extends readonly (infer C extends keyof Row)[]
    ? Pick<Row, C>
    : never

export interface TableEvents<Row> {
  afterInsert: { table: string; rows: Row[] }
  /** `before` and `after` hold the same rows, pre- and post-update; they are not paired by order. */
  afterUpdate: { table: string; before: Row[]; after: Row[] }
  afterDelete: { table: string; rows: Row[] }
}

export interface TableConfig<Select, Insert, Update, Expr> {
  /** Set on insert and never overwritten by an upsert's conflict update. */
  createdAt?: ColumnOf<Select>
  /** Set on insert, update, and an upsert's conflict update. */
  updatedAt?: ColumnOf<Select>
  /** Extra values applied under each inserted row. */
  insertDefaults?: () => Partial<Insert>
  /** Extra values applied over each update's `set`, e.g. a version bump expression. */
  updateDefaults?: () => SetValues<Update, Expr>
  /**
   * Hooks run after the write commits: immediately outside a transaction, after
   * commit inside one, and not at all on rollback. They never block or fail the write;
   * errors go to `onHookError`.
   */
  afterInsert?: (event: TableEvents<Select>['afterInsert']) => unknown
  /** Needs Postgres: `before` is read in the same statement as the update. */
  afterUpdate?: (event: TableEvents<Select>['afterUpdate']) => unknown
  afterDelete?: (event: TableEvents<Select>['afterDelete']) => unknown
}

export type TableConfigs<Tables, Expr> = {
  [T in TableName<Tables>]?: TableConfig<
    SelectRow<Tables, T>,
    InsertRow<Tables, T>,
    UpdateRow<Tables, T>,
    Expr
  >
}

export interface TableUtilsOptions<Tables, Expr> {
  tables?: TableConfigs<Tables, Expr>
  /** The `createdAt` / `updatedAt` value. Default `() => new Date()`. */
  now?: () => unknown
  /** Bind parameters per statement; multi-row writes are chunked to stay under it. */
  maxBindings?: number
  /** Called with hook errors. Defaults to `console.error`. */
  onHookError?: (error: unknown, hook: keyof TableEvents<unknown>, table: string) => void
}
