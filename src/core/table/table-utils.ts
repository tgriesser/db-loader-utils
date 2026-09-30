import type { Row } from '../adapter'
import { RowNotFoundError } from '../errors'
import { bindScope } from '../scope'
import type { AnyScope, ConflictRequest, ReturningRequest, TableAdapter } from './adapter'
import type {
  ColumnOf,
  InsertRow,
  ReadScopeFor,
  ReturnedRow,
  Returning,
  SelectRow,
  SetValues,
  TableConfig,
  TableEvents,
  TableKind,
  TableName,
  TableUtilsOptions,
  UpdateRow,
  Where,
  WriteScopeFor,
} from './types'

type HookName = keyof TableEvents<unknown>
type AnyConfig = TableConfig<Row, Row, Row, unknown>

interface HookCall {
  hook: HookName
  table: string
  fn: (event: any) => unknown
  event: TableEvents<Row>[HookName]
}

/** What a `TableRepo` needs from the `TableUtils` it came from, possibly bound to a transaction. */
interface TableContext {
  adapter: TableAdapter
  maxBindings: number
  now(): unknown
  config(table: string): AnyConfig
  /** Throws before a write whose hook could not be delivered after commit. */
  assertHookable(table: string, hook: HookName): void
  emit(call: HookCall): void
  transact<R>(fn: (ctx: TableContext) => Promise<R>): Promise<R>
}

export class TableUtils<Tables, K extends TableKind> {
  /** Hooks waiting for the enclosing `transaction()` to commit. */
  private pending?: HookCall[]

  constructor(
    protected adapter: TableAdapter<K['executor']>,
    protected readonly options: TableUtilsOptions<Tables, K['expression']> = {},
  ) {}

  table<T extends TableName<Tables>>(name: T): TableRepo<Tables, K, T> {
    return new TableRepo(this.context(), name)
  }

  /**
   * Runs `fn` in a transaction with a bound copy of this instance. Hooks fire after
   * commit and are dropped on rollback. Inside a transaction already, `fn` joins it.
   */
  async transaction<R>(fn: (t: this) => Promise<R>): Promise<R> {
    if (this.adapter.inTransaction) return fn(this)
    const pending: HookCall[] = []
    const result = await this.adapter.transaction((adapter) => fn(this.fork(adapter, pending)))
    for (const call of pending) this.run(call)
    return result
  }

  protected bind(adapter: TableAdapter<K['executor']>): this {
    return this.fork(adapter, undefined)
  }

  private fork(adapter: TableAdapter<K['executor']>, pending: HookCall[] | undefined): this {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this, { adapter, pending })
  }

  private context(): TableContext {
    return {
      adapter: this.adapter,
      maxBindings: this.options.maxBindings ?? this.adapter.maxBindings,
      now: this.options.now ?? (() => new Date()),
      config: (table) => (this.options.tables as Record<string, AnyConfig>)?.[table] ?? {},
      assertHookable: (table, hook) => {
        if (this.pending || !this.adapter.inTransaction || this.adapter.committed) return
        throw new Error(
          `"${table}" has an ${hook} hook, which can't be deferred until this transaction commits; ` +
            `use transaction() instead of withTransaction()`,
        )
      },
      emit: (call) => {
        if (this.pending) this.pending.push(call)
        else if (this.adapter.committed) {
          this.adapter.committed.then(
            () => this.run(call),
            () => {},
          )
        } else this.run(call)
      },
      transact: (fn) => this.transaction((t) => fn(t.context())),
    }
  }

  private run({ hook, table, fn, event }: HookCall): void {
    const onError = this.options.onHookError ?? defaultOnHookError
    Promise.resolve()
      .then(() => fn(event))
      .catch((error) => onError(error, hook, table))
  }
}

function defaultOnHookError(error: unknown, hook: string, table: string) {
  console.error(`table-utils: ${hook} hook for "${table}" failed`, error)
}

export interface ReadOptions<Scope> {
  scope?: Scope
}

export interface WriteOptions<Scope, R> {
  /** Narrows the rows matched by `where`; required when `where` is empty. */
  scope?: Scope
  returning?: R
}

export type UpsertOptions<Insert, Scope> = (
  | {
      conflictOn: readonly ColumnOf<Insert>[]
      onConflict?: 'merge'
      /** Columns left as they are on conflict. `createdAt` and `conflictOn` always are. */
      exclude?: readonly ColumnOf<Insert>[]
    }
  | {
      /** Omitted means any conflict. */
      conflictOn?: readonly ColumnOf<Insert>[]
      onConflict: 'nothing'
    }
) & {
  /** Only update conflicting rows matching this scope. */
  where?: Scope
}

/** An upsert that can skip a row (`onConflict: 'nothing'` or a `where`) may return nothing for it. */
type MaybeSkipped<O, Row> = O extends { onConflict: 'nothing' } | { where: {} } ? Row | null : Row

export class TableRepo<
  Tables,
  K extends TableKind,
  T extends TableName<Tables>,
  S = SelectRow<Tables, T>,
  I = InsertRow<Tables, T>,
  U = UpdateRow<Tables, T>,
  RS = ReadScopeFor<K, T>,
  WS = WriteScopeFor<K, T>,
> {
  constructor(
    private readonly ctx: TableContext,
    readonly name: T,
  ) {}

  // Reads
  // ------------------------------

  async findAllBy(where: Where<S>, opts?: ReadOptions<RS>): Promise<S[]> {
    return (await this.ctx.adapter.select({
      table: this.name,
      where: toWhere(where),
      scope: this.readScope(opts?.scope),
    })) as S[]
  }

  async findOneBy(where: Where<S>, opts?: ReadOptions<RS>): Promise<S | null> {
    const [row] = await this.ctx.adapter.select({
      table: this.name,
      where: toWhere(where),
      scope: this.readScope(opts?.scope),
      limit: 1,
    })
    return (row as S | undefined) ?? null
  }

  async findOrFailBy(where: Where<S>, opts?: ReadOptions<RS>): Promise<S> {
    const row = await this.findOneBy(where, opts)
    if (!row) throw new RowNotFoundError(this.name, where)
    return row
  }

  async exists(where: Where<S>, opts?: ReadOptions<RS>): Promise<boolean> {
    return (await this.findOneBy(where, opts)) !== null
  }

  async countBy(where: Where<S>, opts?: ReadOptions<RS>): Promise<number> {
    return this.ctx.adapter.count({
      table: this.name,
      where: toWhere(where),
      scope: this.readScope(opts?.scope),
    })
  }

  // Inserts
  // ------------------------------

  insert(row: I): Promise<void>
  insert<const R extends Returning<S>>(row: I, opts: { returning: R }): Promise<ReturnedRow<S, R>>
  async insert(row: I, opts?: { returning?: Returning<S> }): Promise<unknown> {
    const rows = await this.insertRows([row], opts?.returning)
    return opts?.returning ? rows[0] : undefined
  }

  /** Split into several statements, in one transaction, when the rows exceed `maxBindings`. */
  insertMany(rows: readonly I[]): Promise<void>
  insertMany<const R extends Returning<S>>(
    rows: readonly I[],
    opts: { returning: R },
  ): Promise<ReturnedRow<S, R>[]>
  async insertMany(rows: readonly I[], opts?: { returning?: Returning<S> }): Promise<unknown> {
    const inserted = await this.insertRows(rows, opts?.returning)
    return opts?.returning ? inserted : undefined
  }

  private async insertRows(rows: readonly I[], returning?: Returning<S>): Promise<Row[]> {
    if (!rows.length) return []
    const { afterInsert } = this.config
    if (afterInsert) this.ctx.assertHookable(this.name, 'afterInsert')
    const prepared = rows.map((r) => this.prepareInsert(r as Row))
    const inserted = await this.eachChunk(prepared, async (ctx, chunk) => {
      const out = await ctx.adapter.insert({
        table: this.name,
        rows: chunk,
        returning: afterInsert ? '*' : returning,
      })
      if (afterInsert) {
        ctx.emit({
          hook: 'afterInsert',
          table: this.name,
          fn: afterInsert,
          event: { table: this.name, rows: out },
        })
      }
      return out
    })
    return project(inserted, returning)
  }

  // Upserts
  // ------------------------------

  upsert<const O extends UpsertOptions<I, WS>, const R extends Returning<S>>(
    row: I,
    opts: O & { returning: R },
  ): Promise<MaybeSkipped<O, ReturnedRow<S, R>>>
  upsert(row: I, opts: UpsertOptions<I, WS>): Promise<void>
  async upsert(
    row: I,
    opts: UpsertOptions<I, WS> & { returning?: Returning<S> },
  ): Promise<unknown> {
    const rows = await this.upsertRows([row], opts)
    return opts.returning ? (rows[0] ?? null) : undefined
  }

  /**
   * Every row must have the same columns. With `onConflict: 'nothing'` or a `where`,
   * skipped rows are missing from the result.
   */
  upsertMany<const R extends Returning<S>>(
    rows: readonly I[],
    opts: UpsertOptions<I, WS> & { returning: R },
  ): Promise<ReturnedRow<S, R>[]>
  upsertMany(rows: readonly I[], opts: UpsertOptions<I, WS>): Promise<void>
  async upsertMany(
    rows: readonly I[],
    opts: UpsertOptions<I, WS> & { returning?: Returning<S> },
  ): Promise<unknown> {
    const upserted = await this.upsertRows(rows, opts)
    return opts.returning ? upserted : undefined
  }

  private async upsertRows(
    rows: readonly I[],
    opts: UpsertOptions<I, WS> & { returning?: Returning<S> },
  ): Promise<Row[]> {
    if (!rows.length) return []
    const config = this.config
    if (config.afterInsert || config.afterUpdate) {
      throw new Error(
        `upsert can't tell inserted rows from updated ones, so it isn't supported on "${this.name}", which has hooks`,
      )
    }
    const prepared = rows.map((r) => this.prepareInsert(r as Row))
    const columns = sameColumns(prepared, 'upsert')
    const conflictOn = opts.conflictOn ?? []
    const conflict: ConflictRequest = { columns: conflictOn, where: opts.where as AnyScope }
    if (opts.onConflict !== 'nothing') {
      const keep = new Set<string>([...conflictOn, ...(opts.exclude ?? [])])
      if (config.createdAt) keep.add(config.createdAt)
      const excluded = columns.filter((c) => !keep.has(c))
      conflict.merge = {
        // With nothing left to update, a no-op update of the conflict columns still
        // lets RETURNING report the existing row, which DO NOTHING would not.
        excluded: excluded.length ? excluded : conflictOn,
        set: (config.updateDefaults?.() as Row | undefined) ?? {},
      }
    }
    return this.eachChunk(prepared, (ctx, chunk) =>
      ctx.adapter.insert({ table: this.name, rows: chunk, returning: opts.returning, conflict }),
    )
  }

  // Updates
  // ------------------------------

  /** Returns the number of rows updated, or the rows when `returning` is given. */
  updateBy(
    where: Where<S>,
    set: SetValues<U, K['expression']>,
    opts?: { scope?: WS },
  ): Promise<number>
  updateBy<const R extends Returning<S>>(
    where: Where<S>,
    set: SetValues<U, K['expression']>,
    opts: WriteOptions<WS, R>,
  ): Promise<ReturnedRow<S, R>[]>
  async updateBy(
    where: Where<S>,
    set: SetValues<U, K['expression']>,
    opts?: WriteOptions<WS, Returning<S>>,
  ): Promise<unknown> {
    const { afterUpdate } = this.config
    const w = toWriteWhere(this.name, 'updateBy', where, opts?.scope)
    if (afterUpdate) {
      if (this.ctx.adapter.dialect !== 'postgres') {
        throw new Error(`afterUpdate hooks need Postgres ("${this.name}")`)
      }
      this.ctx.assertHookable(this.name, 'afterUpdate')
    }
    const result = await this.ctx.adapter.update({
      table: this.name,
      where: w,
      set: this.prepareUpdate(set as Row),
      scope: opts?.scope as AnyScope | undefined,
      returning: afterUpdate ? '*' : opts?.returning,
      captureBefore: !!afterUpdate,
    })
    if (afterUpdate && result.rows.length) {
      this.ctx.emit({
        hook: 'afterUpdate',
        table: this.name,
        fn: afterUpdate,
        event: { table: this.name, before: result.before ?? [], after: result.rows },
      })
    }
    return opts?.returning ? project(result.rows, opts.returning) : result.count
  }

  /** `updateBy` for a `where` that identifies a single row; returns it (all columns by default) or null. */
  async updateOneBy<const R extends Returning<S> = '*'>(
    where: Where<S>,
    set: SetValues<U, K['expression']>,
    opts?: WriteOptions<WS, R>,
  ): Promise<ReturnedRow<S, R> | null> {
    const rows = await this.updateBy(where, set, { ...opts, returning: opts?.returning ?? '*' })
    return (rows[0] as ReturnedRow<S, R> | undefined) ?? null
  }

  async updateOneByOrFail<const R extends Returning<S> = '*'>(
    where: Where<S>,
    set: SetValues<U, K['expression']>,
    opts?: WriteOptions<WS, R>,
  ): Promise<ReturnedRow<S, R>> {
    const row = await this.updateOneBy<R>(where, set, opts)
    if (!row) throw new RowNotFoundError(this.name, where)
    return row
  }

  /**
   * Updates many rows in one statement, each with its own values, matching on `keys`.
   * Every row must have the same columns. Not supported on tables with an afterUpdate hook.
   */
  updateManyBy<C extends ColumnOf<S>>(
    keys: C | readonly C[],
    rows: ReadonlyArray<Pick<S, C> & SetValues<U, never>>,
  ): Promise<number>
  updateManyBy<C extends ColumnOf<S>, const R extends Returning<S>>(
    keys: C | readonly C[],
    rows: ReadonlyArray<Pick<S, C> & SetValues<U, never>>,
    opts: { returning: R },
  ): Promise<ReturnedRow<S, R>[]>
  async updateManyBy(
    keys: string | readonly string[],
    rows: readonly Row[],
    opts?: { returning?: Returning<S> },
  ): Promise<unknown> {
    const config = this.config
    if (config.afterUpdate) {
      throw new Error(
        `updateManyBy isn't supported on "${this.name}", which has an afterUpdate hook`,
      )
    }
    const keyList: readonly string[] = typeof keys === 'string' ? [keys] : keys
    if (!rows.length) return opts?.returning ? [] : 0
    const columns = sameColumns(rows, 'updateManyBy')
    for (const row of rows) toWhere(row)
    for (const k of keyList) {
      if (!columns.includes(k)) throw new Error(`updateManyBy rows are missing key "${k}"`)
    }
    if (columns.length === keyList.length) {
      throw new Error('updateManyBy rows have no columns to set besides the keys')
    }
    const set = this.prepareUpdate({})
    for (const c of columns) delete set[c]
    let count = 0
    const updated = await this.eachChunk(rows, async (ctx, chunk) => {
      const result = await ctx.adapter.updateMany({
        table: this.name,
        keys: keyList,
        columns,
        rows: chunk,
        set,
        returning: opts?.returning,
      })
      count += result.count
      return result.rows
    })
    return opts?.returning ? updated : count
  }

  // Deletes
  // ------------------------------

  destroyBy(where: Where<S>, opts?: { scope?: WS }): Promise<number>
  destroyBy<const R extends Returning<S>>(
    where: Where<S>,
    opts: WriteOptions<WS, R>,
  ): Promise<ReturnedRow<S, R>[]>
  async destroyBy(where: Where<S>, opts?: WriteOptions<WS, Returning<S>>): Promise<unknown> {
    const { afterDelete } = this.config
    const w = toWriteWhere(this.name, 'destroyBy', where, opts?.scope)
    if (afterDelete) this.ctx.assertHookable(this.name, 'afterDelete')
    const result = await this.ctx.adapter.delete({
      table: this.name,
      where: w,
      scope: opts?.scope as AnyScope | undefined,
      returning: afterDelete ? '*' : opts?.returning,
    })
    if (afterDelete && result.rows.length) {
      this.ctx.emit({
        hook: 'afterDelete',
        table: this.name,
        fn: afterDelete,
        event: { table: this.name, rows: result.rows },
      })
    }
    return opts?.returning ? project(result.rows, opts.returning) : result.count
  }

  // Find-or-write
  // ------------------------------

  /** Finds the row matching `values` on `conflictOn`, upserting it if missing. */
  async findOrUpsert(values: I, conflictOn: readonly (ColumnOf<I> & ColumnOf<S>)[]): Promise<S> {
    return (await this.findOrUpsertWithMeta(values, conflictOn)).row
  }

  async findOrUpsertWithMeta(
    values: I,
    conflictOn: readonly (ColumnOf<I> & ColumnOf<S>)[],
  ): Promise<{ created: boolean; row: S }> {
    const existing = await this.findOneBy(pick(values as Row, conflictOn) as Where<S>)
    if (existing) return { created: false, row: existing }
    const row = await this.upsert(values, { conflictOn, returning: '*' })
    return { created: true, row: row as S }
  }

  /**
   * `findOrUpsert` for many rows in two statements at most: one select, then one
   * upsert of the missing rows. Results line up with `values`.
   */
  async findOrUpsertMany(
    values: readonly I[],
    conflictOn: readonly (ColumnOf<I> & ColumnOf<S>)[],
  ): Promise<S[]> {
    if (!values.length) return []
    const rowKey = (r: Row) => JSON.stringify(conflictOn.map((c) => String(r[c])))
    const found = new Map<string, S>()
    const lookups = uniqBy(values as readonly Row[], rowKey).map((v) => conflictOn.map((c) => v[c]))
    await this.eachChunk(lookups, async (ctx, chunk) => {
      const rows = await ctx.adapter.select({
        table: this.name,
        where: {},
        whereIn: { columns: conflictOn, values: chunk },
      })
      for (const row of rows) found.set(rowKey(row), row as S)
      return []
    })
    const missing = uniqBy(
      (values as readonly Row[]).filter((v) => !found.has(rowKey(v))),
      rowKey,
    )
    if (missing.length) {
      const upserted = await this.upsertMany(missing as unknown as I[], {
        conflictOn,
        returning: '*',
      })
      for (const row of upserted) found.set(rowKey(row as Row), row as S)
    }
    return (values as readonly Row[]).map((v) => {
      const row = found.get(rowKey(v))
      // e.g. a citext or numeric column that the database returns normalized differently.
      if (!row) {
        throw new Error(
          `findOrUpsertMany on "${this.name}" couldn't match a row back to ${JSON.stringify(pick(v, conflictOn))}`,
        )
      }
      return row
    })
  }

  /** Finds a row equal to `values` on every given column, inserting `values` if there is none. */
  async findOrCreateBy(values: I & Where<S>): Promise<S> {
    const existing = await this.findOneBy(values)
    if (existing) return existing
    return (await this.insert(values, { returning: '*' })) as S
  }

  // Internals
  // ------------------------------

  private get config(): AnyConfig {
    return this.ctx.config(this.name)
  }

  private prepareInsert(row: Row): Row {
    const { createdAt, updatedAt, insertDefaults } = this.config
    const now = this.ctx.now()
    const out: Row = {}
    if (createdAt) out[createdAt] = now
    if (updatedAt) out[updatedAt] = now
    return { ...out, ...insertDefaults?.(), ...row }
  }

  /** `updatedAt` yields to an explicit value; `updateDefaults` are applied over `set`. */
  private prepareUpdate(set: Row): Row {
    const { updatedAt, updateDefaults } = this.config
    return { ...(updatedAt ? { [updatedAt]: this.ctx.now() } : {}), ...set, ...updateDefaults?.() }
  }

  /** Runs `fn` per chunk sized to `maxBindings`, in one transaction when there is more than one. */
  private async eachChunk<X>(
    items: readonly X[],
    fn: (ctx: TableContext, chunk: X[]) => Promise<Row[]>,
  ): Promise<Row[]> {
    let width = 1
    for (const item of items) width = Math.max(width, Object.keys(item as object).length)
    const size = Math.max(1, Math.floor(this.ctx.maxBindings / width))
    const chunks: X[][] = []
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
    const run = async (ctx: TableContext) => {
      const out: Row[] = []
      for (const chunk of chunks) out.push(...(await fn(ctx, chunk)))
      return out
    }
    return chunks.length > 1 ? this.ctx.transact(run) : run(this.ctx)
  }

  private readScope(scope: unknown): AnyScope | undefined {
    if (!scope) return undefined
    if (typeof scope === 'function') return scope as AnyScope
    const bound = bindScope(scope as Parameters<typeof bindScope>[0])
    if (!bound.def.tables.includes(this.name)) {
      throw new Error(`Scope "${bound.def.name}" is not defined for "${this.name}"`)
    }
    return bound.apply
  }
}

function toWhere(where: object): Row {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) throw new TypeError(`where.${k} is undefined`)
  }
  return where as Row
}

/** An empty `where` with no scope would touch every row, so it is refused. */
function toWriteWhere(table: string, method: string, where: object, scope: unknown): Row {
  const w = toWhere(where)
  if (!scope && Object.keys(w).length === 0) {
    throw new Error(`${method} on "${table}" needs a non-empty where or a scope`)
  }
  return w
}

function sameColumns(rows: readonly Row[], method: string): string[] {
  const columns = Object.keys(rows[0]!).sort()
  for (const row of rows) {
    const keys = Object.keys(row).sort()
    if (keys.length !== columns.length || keys.some((k, i) => k !== columns[i])) {
      throw new Error(`${method} rows must all have the same columns`)
    }
  }
  return columns
}

function project(rows: Row[], returning: ReturningRequest | undefined): Row[] {
  if (!returning || returning === '*') return rows
  return rows.map((r) => pick(r, returning))
}

function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const c of columns) out[c] = row[c]
  return out
}

function uniqBy<X>(items: readonly X[], key: (x: X) => string): X[] {
  const seen = new Map<string, X>()
  for (const item of items) {
    const k = key(item)
    if (!seen.has(k)) seen.set(k, item)
  }
  return Array.from(seen.values())
}
