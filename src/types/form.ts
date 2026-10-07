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
  /** 目标字段的完整字段路径（含分组/容器段，以 . 连接） */
  fieldPath: string
  operator: ConditionOperator
  value: string | number
}

/** 旧版本 Schema 使用的字段 id 联动，仅用于归一化导入 */
export interface LegacyVisibilityCondition {
  fieldId?: string
  fieldPath?: string
  operator?: ConditionOperator
  value?: string | number
}

export interface FieldNode {
  id: string
  type: FieldType
  label: string
  /** 字段标识；配合祖先分组/容器组成字段路径，是联动与答案迁移的唯一键 */
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
  [fieldPath: string]: unknown
}

/** 一次发布产生的冻结版本：字段结构、校验、联动条件都不再随草稿变化 */
export interface PublishedRevision {
  rev: number
  schema: FormSchema
  publishedAt: string
  note?: string
}

export interface ReleaseDoc {
  revisions: PublishedRevision[]
  /** 当前工作草稿所基于（最近一次发布）的版本号，null 表示草稿从未发布 */
  draftBaseline: number | null
}

export type MigrationConflictReason = 'field_missing' | 'type_changed'

/** 发布版本更新后无法按字段路径直接对上的旧答案 */
export interface MigrationConflict {
  id: string
  oldPath: string
  oldLabel: string
  oldType: FieldType | 'unknown'
  /** 同路径但类型/表格结构变化时的新字段标题 */
  newLabel?: string
  value: unknown
  reason: MigrationConflictReason
  /** 类型兼容、可补入的新字段路径 */
  candidates: string[]
}

/** 用户选择保留的对不上旧值，永不自动丢弃 */
export interface RetainedAnswer {
  oldPath: string
  label: string
  value: unknown
  reason: MigrationConflictReason
  retainedAt: string
}

export interface SessionMigration {
  fromRev: number
  targetRev: number
  /** 迁移开始时的旧版本答案快照，迁移失败或重试时据此完整恢复 */
  originalAnswers: RuntimeValueMap
  startedAt: string
  conflicts: MigrationConflict[]
  retained: RetainedAnswer[]
  matchedCount: number
  lastError?: string
}

export type SessionStatus = 'open' | 'submitted'

/** 填单会话：始终锚定开始时（或迁移目标）的发布版本 */
export interface FillSession {
  id: string
  revId: number
  status: SessionStatus
  answers: RuntimeValueMap
  startedAt: string
  updatedAt: string
  submittedAt?: string
  migration: SessionMigration | null
  /** 历次迁移中对不上而选择两边保留的旧值，长期留存不随提交丢弃 */
  retainedAnswers: RetainedAnswer[]
}

export interface SessionsDoc {
  sessions: FillSession[]
}
