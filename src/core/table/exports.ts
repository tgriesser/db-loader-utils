export { RowNotFoundError } from '../errors'
export {
  TableRepo,
  TableUtils,
  type ReadOptions,
  type UpsertOptions,
  type WriteOptions,
} from './table-utils'
export type { TableAdapter, Dialect, ConflictRequest, WriteResult } from './adapter'
export type {
  ColumnOf,
  InsertRow,
  ReadScopeFor,
  ReturnedRow,
  Returning,
  SelectRow,
  SetValues,
  TableConfig,
  TableConfigs,
  TableEvents,
  TableKind,
  TableName,
  TableTypes,
  TableUtilsOptions,
  UpdateRow,
  Where,
  WriteScopeFor,
} from './types'
