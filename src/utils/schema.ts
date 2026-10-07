import type {
  FieldNode,
  FormSchema,
  LegacyVisibilityCondition,
  MigrationConflict,
  RuntimeValueMap,
  RetainedAnswer,
  ValidationRule,
  VisibilityCondition,
} from '../types/form'
import { createId } from './id'

export function cloneSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createField(type: FieldNode['type']): FieldNode {
  const base: FieldNode = {
    id: createId(type),
    type,
    label: type === 'group' ? '基本信息' : type === 'container' ? '业务区域' : `新建${typeLabel(type)}`,
    name: `${type}_${Math.random().toString(36).slice(2, 6)}`,
    validation: { required: false },
  }
  if (type === 'input') base.placeholder = '请输入内容'
  if (type === 'select') {
    base.placeholder = '请选择'
    base.options = ['选项 A', '选项 B', '选项 C']
  }
  if (type === 'date') base.placeholder = '请选择日期'
  if (type === 'table') {
    base.columns = [
      { key: 'name', label: '项目名称', type: 'text' },
      { key: 'amount', label: '金额', type: 'number' },
      { key: 'date', label: '日期', type: 'date' },
    ]
    base.children = []
  }
  if (type === 'group' || type === 'container') base.children = []
  return base
}

export function typeLabel(type: FieldNode['type']): string {
  return {
    input: '输入框',
    select: '选择器',
    date: '日期',
    table: '表格',
    group: '分组',
    container: '自定义容器',
  }[type]
}

export function isContainerType(type: FieldNode['type']): boolean {
  return type === 'group' || type === 'container'
}

export function isDataField(node: FieldNode): boolean {
  return node.type !== 'group' && node.type !== 'container'
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}.${name}` : name
}

export function flattenNodes(nodes: FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])])
}

export interface FlatField {
  node: FieldNode
  path: string
}

/** 遍历可承载答案的字段（含分组/容器内的嵌套字段；表格列不作为独立字段） */
export function collectFields(nodes: FieldNode[], parentPath = ''): FlatField[] {
  const result: FlatField[] = []
  const walk = (items: FieldNode[], parent: string) => {
    items.forEach((node) => {
      const path = joinPath(parent, node.name)
      if (isContainerType(node.type)) {
        walk(node.children ?? [], path)
      } else {
        result.push({ node, path })
      }
    })
  }
  walk(nodes, parentPath)
  return result
}

/** 可作为联动条件目标的字段（输入框、选择器、日期） */
export function collectConditionSources(nodes: FieldNode[]): FlatField[] {
  return collectFields(nodes).filter(({ node }) => node.type === 'input' || node.type === 'select' || node.type === 'date')
}

export function fieldPathSet(nodes: FieldNode[]): Set<string> {
  return new Set(collectFields(nodes).map(({ path }) => path))
}

export function findNode(nodes: FieldNode[], id: string): FieldNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findNode(node.children ?? [], id)
    if (child) return child
  }
  return undefined
}

export function findFieldByPath(nodes: FieldNode[], targetPath: string): FieldNode | undefined {
  return collectFields(nodes).find(({ path }) => path === targetPath)?.node
}

export function findParent(nodes: FieldNode[], id: string, parent?: FieldNode): FieldNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent
    const found = findParent(node.children ?? [], id, node)
    if (found !== undefined) return found
  }
  return undefined
}

export function removeNode(nodes: FieldNode[], id: string): boolean {
  const index = nodes.findIndex((node) => node.id === id)
  if (index >= 0) {
    nodes.splice(index, 1)
    return true
  }
  return nodes.some((node) => removeNode(node.children ?? [], id))
}

export function insertNode(nodes: FieldNode[], node: FieldNode, parentId?: string, index?: number): boolean {
  if (!parentId) {
    nodes.splice(index ?? nodes.length, 0, node)
    return true
  }
  const parent = findNode(nodes, parentId)
  if (!parent) return false
  if (!parent.children) parent.children = []
  parent.children.splice(index ?? parent.children.length, 0, node)
  return true
}

export function moveNode(nodes: FieldNode[], sourceId: string, targetParentId?: string, targetIndex = 0): void {
  const source = findNode(nodes, sourceId)
  if (!source) return
  const cloned = cloneSchema(source)
  removeNode(nodes, sourceId)
  if (targetParentId && !findNode(nodes, targetParentId)) {
    nodes.push(cloned)
    return
  }
  insertNode(nodes, cloned, targetParentId, targetIndex)
}

/** 按字段结构生成默认答案（开始会话 / 迁移目标版本初始化） */
export function buildDefaultValues(nodes: FieldNode[]): RuntimeValueMap {
  const values: RuntimeValueMap = {}
  collectFields(nodes).forEach(({ node, path }) => {
    if (node.type === 'table') values[path] = []
    else if (node.defaultValue !== undefined) values[path] = cloneSchema(node.defaultValue)
    else values[path] = ''
  })
  return values
}

export function isValueEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

/** 把旧版 Schema（fieldId 联动）归一化为当前字段路径模型 */
export function normalizeSchema(raw: unknown): FormSchema | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<FormSchema>
  if (typeof candidate.title !== 'string' || !Array.isArray(candidate.nodes)) return null

  const nodes = cloneSchema(candidate.nodes as FieldNode[])
  const idToPath = new Map<string, string>()
  collectFields(nodes).forEach(({ node, path }) => idToPath.set(node.id, path))

  const normalizeCondition = (condition?: LegacyVisibilityCondition): VisibilityCondition | undefined => {
    if (!condition) return undefined
    const fieldPath = condition.fieldPath ?? (condition.fieldId ? idToPath.get(condition.fieldId) : undefined)
    if (!fieldPath || !condition.operator) return undefined
    return { fieldPath, operator: condition.operator, value: condition.value ?? '' }
  }

  flattenNodes(nodes).forEach((node) => {
    node.condition = normalizeCondition(node.condition as LegacyVisibilityCondition | undefined)
  })

  return {
    version: 1,
    title: candidate.title,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    nodes,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  }
}

export interface ConditionEval {
  visible: boolean
  /** 联动目标字段路径已不存在（字段标识被改 / 字段被删），条件立即失效 */
  broken: boolean
}

export function evaluateCondition(
  condition: VisibilityCondition | undefined,
  values: RuntimeValueMap,
  validPaths?: Set<string>,
): ConditionEval {
  if (!condition?.fieldPath) return { visible: true, broken: false }
  if (validPaths && !validPaths.has(condition.fieldPath)) return { visible: false, broken: true }
  const current = values[condition.fieldPath]
  const compare = condition.value
  switch (condition.operator) {
    case 'equals': return { visible: String(current ?? '') === String(compare), broken: false }
    case 'notEquals': return { visible: String(current ?? '') !== String(compare), broken: false }
    case 'contains': return { visible: String(current ?? '').includes(String(compare)), broken: false }
    case 'greaterThan': return { visible: Number(current) > Number(compare), broken: false }
    case 'lessThan': return { visible: Number(current) < Number(compare), broken: false }
    default: return { visible: true, broken: false }
  }
}

export function validateValue(value: unknown, rule?: ValidationRule): string | null {
  if (!rule) return null
  const empty = isValueEmpty(value)
  if (rule.required && empty) return rule.message || '此项为必填项'
  if (empty) return null
  const text = String(value)
  if (rule.minLength !== undefined && text.length < rule.minLength) return rule.message || `至少输入 ${rule.minLength} 个字符`
  if (rule.maxLength !== undefined && text.length > rule.maxLength) return rule.message || `最多输入 ${rule.maxLength} 个字符`
  if (rule.min !== undefined && Number(value) < rule.min) return rule.message || `不能小于 ${rule.min}`
  if (rule.max !== undefined && Number(value) > rule.max) return rule.message || `不能大于 ${rule.max}`
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern).test(text)) return rule.message || '格式不符合要求'
    } catch {
      return '校验正则表达式无效'
    }
  }
  return null
}

const NAME_PATTERN = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥-]*$/

export function isValidFieldName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/** 重命名字段标识前的结构校验（非空、合法、且不与既有字段路径冲突） */
export function validateRename(nodes: FieldNode[], id: string, nextName: string): string | null {
  const trimmed = nextName.trim()
  if (!trimmed) return '字段标识不能为空'
  if (!isValidFieldName(trimmed)) return '字段标识需以字母或下划线开头，仅含字母、数字、下划线与短横线'
  const candidate = cloneSchema(nodes)
  const target = findNode(candidate, id)
  if (!target) return '字段不存在'
  target.name = trimmed
  const seen = new Set<string>()
  for (const { path } of collectFields(candidate)) {
    if (seen.has(path)) return `字段路径 ${path} 与其他字段重复，请修改标识或调整嵌套层级`
    seen.add(path)
  }
  return null
}

function tableColumnsSignature(node: FieldNode): string {
  return [...(node.columns ?? [])].map((column) => column.key).sort().join('|')
}

/** 旧字段答案是否可按结构补入新字段（同类型；表格要求列集合一致） */
export function isFieldCompatible(oldNode: FieldNode, newNode: FieldNode): boolean {
  if (oldNode.type !== newNode.type) return false
  if (oldNode.type === 'table') return tableColumnsSignature(oldNode) === tableColumnsSignature(newNode)
  return true
}

export interface MigrationPlan {
  answers: RuntimeValueMap
  conflicts: MigrationConflict[]
  matchedCount: number
}

/**
 * 比较两个发布版本，按字段路径迁移旧会话答案：
 * - 路径对得上且结构兼容：直接补入新版本答案；
 * - 字段被删/改名：旧值列入待处理，可映射到兼容的新字段或保留；
 * - 同路径但类型/表格列变化：两边值都保留，列成待处理。
 */
export function planMigration(oldSchema: FormSchema, newSchema: FormSchema, oldAnswers: RuntimeValueMap): MigrationPlan {
  const answers = buildDefaultValues(newSchema.nodes)
  const newFields = collectFields(newSchema.nodes)
  const newByPath = new Map(newFields.map((field) => [field.path, field.node]))
  const conflicts: MigrationConflict[] = []
  let matchedCount = 0

  collectFields(oldSchema.nodes).forEach(({ node, path }) => {
    const oldValue = oldAnswers[path]
    if (isValueEmpty(oldValue)) return
    const newNode = newByPath.get(path)
    if (newNode && isFieldCompatible(node, newNode)) {
      answers[path] = cloneSchema(oldValue)
      matchedCount += 1
      return
    }
    const candidates = newFields
      .filter((field) => isFieldCompatible(node, field.node))
      .map((field) => field.path)
    conflicts.push({
      id: `c${conflicts.length}`,
      oldPath: path,
      oldLabel: node.label,
      oldType: node.type,
      newLabel: newNode?.label,
      value: cloneSchema(oldValue),
      reason: newNode ? 'type_changed' : 'field_missing',
      candidates,
    })
  })

  return { answers, conflicts, matchedCount }
}

export interface ConflictResolutionResult {
  answers: RuntimeValueMap
  conflicts: MigrationConflict[]
  retained: RetainedAnswer[]
}

/**
 * 处理一条迁移冲突。
 * - map：旧值补入目标字段（目标已被手工填写时拒绝，避免覆盖）；
 * - retain：两边都不丢，旧值列入保留数据。
 */
export function resolveMigrationConflict(
  prev: ConflictResolutionResult,
  conflictId: string,
  action: 'map' | 'retain',
  targetPath?: string,
  defaults: RuntimeValueMap = {},
): { result: ConflictResolutionResult; error?: string } {
  const conflict = prev.conflicts.find((item) => item.id === conflictId)
  if (!conflict) return { result: prev, error: '待处理项不存在或已处理' }
  const answers = cloneSchema(prev.answers)
  const retained = cloneSchema(prev.retained)

  if (action === 'map') {
    if (!targetPath) return { result: prev, error: '请选择要补入的目标字段' }
    const currentValue = answers[targetPath]
    if (!isValueEmpty(currentValue) && JSON.stringify(currentValue) !== JSON.stringify(defaults[targetPath])) {
      return { result: prev, error: `目标字段 ${targetPath} 已填写，为避免覆盖请先清空该字段` }
    }
    answers[targetPath] = cloneSchema(conflict.value)
  } else {
    retained.push({
      oldPath: conflict.oldPath,
      label: conflict.oldLabel,
      value: cloneSchema(conflict.value),
      reason: conflict.reason,
      retainedAt: new Date().toISOString(),
    })
  }

  return {
    result: {
      answers,
      conflicts: prev.conflicts.filter((item) => item.id !== conflictId),
      retained,
    },
  }
}

export function createStarterSchema(): FormSchema {
  const name = createField('input')
  name.label = '申请人姓名'
  name.name = 'applicantName'
  name.validation = { required: true, minLength: 2, message: '请输入至少 2 个字符的姓名' }

  const type = createField('select')
  type.label = '申请类型'
  type.name = 'requestType'
  type.options = ['差旅报销', '采购申请', '合同审批', '其他']
  type.validation = { required: true }

  const amount = createField('input')
  amount.label = '申请金额'
  amount.name = 'amount'
  amount.placeholder = '请输入金额'
  amount.validation = { required: true, pattern: '^\\d+(\\.\\d{1,2})?$', message: '请输入合法金额，最多两位小数' }
  amount.condition = { fieldPath: 'requestType', operator: 'notEquals', value: '其他' }

  const date = createField('date')
  date.label = '期望日期'
  date.name = 'expectedDate'
  date.validation = { required: true }

  const reason = createField('container')
  reason.label = '申请说明'
  reason.name = 'reasonSection'
  const detail = createField('input')
  detail.label = '补充说明'
  detail.name = 'detail'
  detail.placeholder = '请说明申请背景与用途'
  detail.validation = { required: true, minLength: 5 }
  reason.children = [detail]

  const table = createField('table')
  table.label = '费用明细'
  table.name = 'expenses'
  table.condition = { fieldPath: 'requestType', operator: 'equals', value: '差旅报销' }

  return {
    version: 1 as const,
    title: '费用申请审批表',
    description: '请完整填写申请信息，带 * 的字段为必填项。',
    nodes: [name, type, amount, date, reason, table],
    updatedAt: new Date().toISOString(),
  }
}
