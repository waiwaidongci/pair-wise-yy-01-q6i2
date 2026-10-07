import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FieldNode, FormSchema } from '../types/form'
import { DRAFT_KEY, initWorkspace } from './workspace'
import { useReleaseStore } from './release'
import {
  cloneSchema,
  collectConditionSources,
  collectFields,
  createField,
  findNode,
  insertNode,
  moveNode,
  normalizeSchema,
  removeNode,
  validateRename,
} from '../utils/schema'
import { writeAtomic } from '../utils/storage'

export const useDesignerStore = defineStore('designer', () => {
  const workspace = initWorkspace()
  const releaseStore = useReleaseStore()
  const draft = ref<FormSchema>(workspace.draft)
  const selectedId = ref<string | null>(draft.value.nodes[0]?.id ?? null)
  const history = ref<FormSchema[]>([])
  const historyIndex = ref(-1)
  const saveState = ref('草稿已加载')
  let saveTimer: number | undefined

  const title = computed(() => draft.value.title)
  const description = computed(() => draft.value.description)
  const nodes = computed(() => draft.value.nodes)

  const selectedNode = computed(() => selectedId.value ? findNode(nodes.value, selectedId.value) : undefined)
  const flatFields = computed(() => collectConditionSources(nodes.value))
  const fieldPaths = computed(() => new Set(collectFields(nodes.value).map(({ path }) => path)))
  const schema = computed<FormSchema>(() => ({
    version: 1,
    title: title.value,
    description: description.value,
    nodes: cloneSchema(nodes.value),
    updatedAt: draft.value.updatedAt,
  }))
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

  /** 当前草稿与最近一次发布是否存在内容差异（结构、校验、联动条件任一不同即待发布） */
  const draftDirty = computed(() => {
    if (releaseStore.revisions.length === 0) return true
    const baseline = releaseStore.draftBaseline === releaseStore.latestRevision?.rev
      ? releaseStore.latestRevision!.schema
      : null
    if (!baseline) return true
    const comparable = (value: FormSchema) => JSON.stringify({ title: value.title, description: value.description, nodes: value.nodes })
    return comparable(schema.value) !== comparable(baseline)
  })

  function setTitle(value: string) {
    draft.value.title = value
    saveDraft()
  }

  function setDescription(value: string) {
    draft.value.description = value
    saveDraft()
  }

  /** 无历史快照的静默落盘（标题输入、撤销重做等场景使用） */
  function saveDraft(message = '草稿已自动保存') {
    saveState.value = '正在保存...'
    window.clearTimeout(saveTimer)
    const snapshot = cloneSchema(draft.value)
    saveTimer = window.setTimeout(() => {
      try {
        writeAtomic(DRAFT_KEY, snapshot)
        saveState.value = `${message} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      } catch {
        saveState.value = '草稿保存失败，内容仍保留在当前页面'
      }
    }, 350)
  }

  function recordHistory() {
    const snapshot = cloneSchema(schema.value)
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(snapshot)
    if (history.value.length > 60) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  function commitDraft(message = '变更已保存') {
    recordHistory()
    saveDraft(message)
  }

  function mutate(mutator: (draftNodes: FieldNode[]) => void, message = '画布已更新') {
    const next = cloneSchema(draft.value)
    next.updatedAt = new Date().toISOString()
    mutator(next.nodes)
    draft.value = next
    commitDraft(message)
  }

  function addField(type: FieldNode['type'], parentId?: string, index?: number) {
    const node = createField(type)
    mutate((draftNodes) => {
      if (!insertNode(draftNodes, node, parentId, index)) draftNodes.push(node)
    }, `已添加${node.label}`)
    selectedId.value = node.id
  }

  function addNodeInstance(node: FieldNode, parentId?: string, index?: number) {
    const cloned = cloneSchema(node)
    cloned.id = createField(node.type).id
    const normalizeChildren = (children: FieldNode[] = []) => children.forEach((child) => {
      child.id = createField(child.type).id
      normalizeChildren(child.children)
    })
    normalizeChildren(cloned.children)
    mutate((draftNodes) => insertNode(draftNodes, cloned, parentId, index), '组件已放入画布')
    selectedId.value = cloned.id
  }

  function updateSelected(patch: Partial<FieldNode>) {
    if (!selectedId.value) return
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const error = validateRename(nodes.value, selectedId.value, String(patch.name))
      if (error) {
        saveState.value = error
        return error
      }
    }
    mutate((draftNodes) => {
      const node = findNode(draftNodes, selectedId.value!)
      if (node) Object.assign(node, cloneSchema(patch))
    }, '属性已更新')
    return null
  }

  /** 修改字段标识：合法才生效；改名后引用旧路径的联动条件立即失效 */
  function renameField(id: string, nextName: string): string | null {
    const error = validateRename(nodes.value, id, nextName)
    if (error) return error
    mutate((draftNodes) => {
      const node = findNode(draftNodes, id)
      if (node) node.name = nextName.trim()
    }, '字段标识已修改，联动条件已重算')
    return null
  }

  function updateValidation(patch: Partial<NonNullable<FieldNode['validation']>>) {
    if (!selectedId.value) return
    mutate((draftNodes) => {
      const node = findNode(draftNodes, selectedId.value!)
      if (node) node.validation = { ...(node.validation ?? { required: false }), ...patch }
    }, '校验规则已更新')
  }

  function updateCondition(patch: Partial<NonNullable<FieldNode['condition']>>) {
    if (!selectedId.value) return
    mutate((draftNodes) => {
      const node = findNode(draftNodes, selectedId.value!)
      if (!node) return
      node.condition = { fieldPath: '', operator: 'equals', value: '', ...(node.condition ?? {}), ...patch }
      if (patch.fieldPath === '') node.condition = undefined
    }, '联动条件已更新')
  }

  function moveNodeTo(sourceId: string, parentId?: string, index = 0) {
    mutate((draftNodes) => moveNode(draftNodes, sourceId, parentId, index), '节点顺序已调整')
  }

  function removeSelected() {
    if (!selectedId.value) return
    const id = selectedId.value
    mutate((draftNodes) => removeNode(draftNodes, id), '节点已删除')
    selectedId.value = draft.value.nodes[0]?.id ?? null
  }

  function removeNodeById(id: string) {
    mutate((draftNodes) => removeNode(draftNodes, id), '节点已删除')
    if (selectedId.value === id) selectedId.value = draft.value.nodes[0]?.id ?? null
  }

  function duplicateNode(source: FieldNode) {
    const copy = cloneSchema(source)
    copy.id = createField(copy.type).id
    copy.name = `${copy.name}_copy`
    copy.label = `${copy.label} 副本`
    const walk = (items: FieldNode[]) => items.forEach((item) => {
      item.id = createField(item.type).id
      walk(item.children ?? [])
    })
    walk(copy.children ?? [])
    mutate((draftNodes) => draftNodes.push(copy), '节点已复制')
    selectedId.value = copy.id
  }

  function duplicateSelected() {
    if (!selectedId.value) return
    const source = findNode(nodes.value, selectedId.value)
    if (source) duplicateNode(source)
  }

  function duplicateNodeById(id: string) {
    const source = findNode(nodes.value, id)
    if (source) duplicateNode(source)
  }

  function undo() {
    if (!canUndo.value) return
    historyIndex.value -= 1
    applySnapshot(history.value[historyIndex.value])
  }

  function redo() {
    if (!canRedo.value) return
    historyIndex.value += 1
    applySnapshot(history.value[historyIndex.value])
  }

  function applySnapshot(snapshot: FormSchema) {
    draft.value = cloneSchema(snapshot)
    if (!findNode(draft.value.nodes, selectedId.value ?? '')) selectedId.value = draft.value.nodes[0]?.id ?? null
    saveDraft()
  }

  /** 发布冻结版本；发布后草稿与新版本一致，继续修改只会停留在新草稿 */
  function publish(note?: string) {
    const revision = releaseStore.publish({ ...cloneSchema(schema.value), updatedAt: new Date().toISOString() }, note)
    draft.value = cloneSchema(revision.schema)
    history.value = []
    historyIndex.value = -1
    recordHistory()
    saveDraft('新版本已发布')
    return revision
  }

  function replaceSchema(next: FormSchema) {
    const normalized = normalizeSchema(next)
    if (!normalized) throw new Error('Schema 缺少 title 或 nodes')
    draft.value = cloneSchema(normalized)
    selectedId.value = draft.value.nodes[0]?.id ?? null
    history.value = []
    historyIndex.value = -1
    releaseStore.clearBaseline()
    recordHistory()
    saveDraft('Schema 已导入为新草稿')
  }

  recordHistory()

  return {
    title,
    description,
    nodes,
    selectedId,
    selectedNode,
    flatFields,
    fieldPaths,
    schema,
    saveState,
    canUndo,
    canRedo,
    draftDirty,
    setTitle,
    setDescription,
    addField,
    addNodeInstance,
    updateSelected,
    renameField,
    updateValidation,
    updateCondition,
    moveNodeTo,
    removeSelected,
    removeNodeById,
    duplicateSelected,
    duplicateNodeById,
    undo,
    redo,
    replaceSchema,
    publish,
    commitDraft,
    saveDraft,
    mutate,
  }
})
