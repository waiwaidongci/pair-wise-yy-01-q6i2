export type FieldType = 'input' | 'select' | 'date' | 'table' | 'group' | 'container'
export type ConditionOperator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan'

export interface TableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'date'
}

export interface ValidationRule {
  required: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  message?: string
}

export interface VisibilityCondition {
  /** 被引用字段的节点 id（稳定身份，用于删除检测与下拉选择） */
  fieldId: string
  /** 设置条件时该字段的路径快照；字段标识改名后用于判定条件失效 */
  fieldPath?: string
  operator: ConditionOperator
  value: string | number
  /** 引用字段被删除或改名后置为 true，预览按 fail-open 立即重算 */
  broken?: boolean
}

export interface FieldNode {
  id: string
  type: FieldType
  label: string
  name: string
  placeholder?: string
  defaultValue?: unknown
  options?: string[]
  columns?: TableColumn[]
  validation?: ValidationRule
  condition?: VisibilityCondition
  children?: FieldNode[]
}

export interface FormSchema {
  version: 1
  title: string
  description: string
  nodes: FieldNode[]
  updatedAt: string
}

export interface RuntimeValueMap {
  [path: string]: unknown
}

/** 发布版本：发布时冻结的 Schema 快照，不可变 */
export interface PublishedVersion {
  id: string
  number: number
  schema: FormSchema
  publishedAt: string
  note: string
}

export type SessionStatus = 'in_progress' | 'submitted' | 'migration_failed'

export type PendingReason = 'missing_in_new' | 'type_changed'

/** 迁移时对不上的答案：两边值都保留，列为待处理 */
export interface PendingAnswer {
  path: string
  label: string
  oldValue: unknown
  newValue?: unknown
  reason: PendingReason
  detail: string
}

export interface FormSession {
  id: string
  versionId: string
  versionNumber: number
  status: SessionStatus
  values: RuntimeValueMap
  pendingAnswers: PendingAnswer[]
  startedAt: string
  updatedAt: string
  submittedAt?: string
  migrationError?: string
  lastMigratedAt?: string
}
