import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FillSession, FormSchema, PublishedRevision, SessionsDoc } from '../types/form'
import { SESSIONS_KEY, initWorkspace } from './workspace'
import { useReleaseStore } from './release'
import {
  buildDefaultValues,
  cloneSchema,
  collectFields,
  evaluateCondition,
  isValueEmpty,
  planMigration,
  resolveMigrationConflict,
} from '../utils/schema'
import { writeAtomic } from '../utils/storage'

export const useSessionsStore = defineStore('sessions', () => {
  const workspace = initWorkspace()
  const releaseStore = useReleaseStore()
  const doc = ref<SessionsDoc>(workspace.sessions)
  const persistError = ref('')
  const activeId = ref<string | null>(workspace.sessions.sessions[0]?.id ?? null)

  const sessions = computed(() => doc.value.sessions)
  const activeSession = computed(() => sessions.value.find((item) => item.id === activeId.value) ?? null)

  /** 会话始终按锚定版本恢复：进行中版本可能已不在“最新”，但结构永远能取回 */
  function revisionOf(session: FillSession): PublishedRevision | undefined {
    return releaseStore.getRevision(session.revId)
  }

  function schemaOf(session: FillSession): FormSchema | null {
    return revisionOf(session)?.schema ?? null
  }

  function isAhead(session: FillSession): boolean {
    const latest = releaseStore.latestRevision
    return !!latest && latest.rev > session.revId
  }

  /** 所有写操作：先原子落盘，成功后才更新内存；失败时原会话完整保留 */
  function commit(nextDoc: SessionsDoc): boolean {
    try {
      writeAtomic(SESSIONS_KEY, nextDoc)
      doc.value = nextDoc
      persistError.value = ''
      return true
    } catch (error) {
      persistError.value = error instanceof Error ? error.message : '写入失败，已保留已有答案'
      return false
    }
  }

  function updateSession(id: string, updater: (session: FillSession) => void): FillSession | null {
    const next = cloneSchema(doc.value)
    const target = next.sessions.find((item) => item.id === id)
    if (!target) return null
    updater(target)
    target.updatedAt = new Date().toISOString()
    return commit(next) ? target : null
  }

  function startSession(): FillSession {
    const latest = releaseStore.latestRevision
    if (!latest) throw new Error('还没有发布版本，请先在设计器发布表单')
    const now = new Date().toISOString()
    const session: FillSession = {
      id: `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      revId: latest.rev,
      status: 'open',
      answers: buildDefaultValues(latest.schema.nodes),
      startedAt: now,
      updatedAt: now,
      migration: null,
      retainedAnswers: [],
    }
    const next = cloneSchema(doc.value)
    next.sessions.push(session)
    if (!commit(next)) throw new Error('会话创建失败：无法写入本地存储')
    activeId.value = session.id
    return session
  }

  function selectSession(id: string) {
    if (doc.value.sessions.some((item) => item.id === id)) activeId.value = id
  }

  /** 填单过程中逐字段写入，任何中断都不会丢掉已录答案 */
  function updateAnswer(id: string, path: string, value: unknown): boolean {
    const updated = updateSession(id, (session) => {
      session.answers[path] = value
    })
    return !!updated
  }

  /**
   * 会话按“开始时版本”继续填写；用户确认后才迁移到新版本。
   * 迁移在内存中规划，再用一次原子写入落地：写失败则会话原样保留，可重试。
   */
  function beginMigration(id: string, targetRev?: number): { ok: boolean; error?: string } {
    const session = doc.value.sessions.find((item) => item.id === id)
    if (!session) return { ok: false, error: '会话不存在' }
    if (session.migration) return { ok: false, error: '该会话已有待完成的迁移，请处理或重试' }

    const oldRevision = releaseStore.getRevision(session.revId)
    const target = targetRev !== undefined ? releaseStore.getRevision(targetRev) : releaseStore.latestRevision
    if (!oldRevision || !target) return { ok: false, error: '发布版本缺失，无法迁移' }
    if (target.rev <= session.revId) return { ok: false, error: '当前版本已不落后，无需迁移' }

    try {
      const plan = planMigration(oldRevision.schema, target.schema, session.answers)
      const next = cloneSchema(doc.value)
      const targetSession = next.sessions.find((item) => item.id === id)
      if (!targetSession) return { ok: false, error: '会话不存在' }
      targetSession.answers = plan.answers
      targetSession.updatedAt = new Date().toISOString()
      if (plan.conflicts.length === 0) {
        // 全部能按路径对上：直接补入并切到新版本
        targetSession.revId = target.rev
        targetSession.migration = null
      } else {
        targetSession.migration = {
          fromRev: session.revId,
          targetRev: target.rev,
          originalAnswers: cloneSchema(session.answers),
          startedAt: new Date().toISOString(),
          conflicts: plan.conflicts,
          retained: [],
          matchedCount: plan.matchedCount,
        }
      }
      if (!commit(next)) return { ok: false, error: persistError.value || '迁移写入失败，会话保持原样，可重试' }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '迁移规划失败，会话保持原样' }
    }
  }

  /** 迁移失败（或误操作）后放弃当前尝试，完整恢复开始时版本与已录答案 */
  function retryMigration(id: string): { ok: boolean; error?: string } {
    const session = doc.value.sessions.find((item) => item.id === id)
    const migration = session?.migration
    if (!session || !migration) return { ok: false, error: '没有进行中的迁移' }
    const oldRevision = releaseStore.getRevision(migration.fromRev)
    if (!oldRevision) return { ok: false, error: `版本 v${migration.fromRev} 已不存在，无法回退` }

    const updated = updateSession(id, (target) => {
      target.revId = migration.fromRev
      target.answers = cloneSchema(migration.originalAnswers)
      target.migration = null
    })
    if (!updated) return { ok: false, error: persistError.value || '回退失败，会话保持原样' }

    // 回退成功后重新规划迁移
    return beginMigration(id, migration.targetRev)
  }

  function cancelMigration(id: string): { ok: boolean; error?: string } {
    return retryMigration(id)
  }

  /** 对不上的旧值：补入选定新字段，或两边都保留列待处理 */
  function resolveConflict(
    id: string,
    conflictId: string,
    action: 'map' | 'retain',
    targetPath?: string,
  ): { ok: boolean; error?: string } {
    const session = doc.value.sessions.find((item) => item.id === id)
    const migration = session?.migration
    if (!session || !migration) return { ok: false, error: '没有进行中的迁移' }
    const targetRevision = releaseStore.getRevision(migration.targetRev)
    if (!targetRevision) return { ok: false, error: '目标发布版本缺失' }

    const defaults = buildDefaultValues(targetRevision.schema.nodes)
    const { result, error } = resolveMigrationConflict(
      { answers: session.answers, conflicts: migration.conflicts, retained: migration.retained },
      conflictId,
      action,
      targetPath,
      defaults,
    )
    if (error) return { ok: false, error }

    const updated = updateSession(id, (target) => {
      target.answers = result.answers
      if (!target.migration) return
      target.migration.conflicts = result.conflicts
      target.migration.retained = result.retained
      target.migration.lastError = undefined
      // 全部冲突处理完成：正式切到新版本；保留值并入会话，长期留存
      if (result.conflicts.length === 0) {
        target.retainedAnswers = [...target.retainedAnswers, ...result.retained]
        target.revId = target.migration.targetRev
        target.migration = null
      }
    })
    return updated ? { ok: true } : { ok: false, error: persistError.value || '处理失败，已保留原有答案' }
  }

  function submit(id: string): { ok: boolean; error?: string } {
    const session = doc.value.sessions.find((item) => item.id === id)
    if (!session) return { ok: false, error: '会话不存在' }
    if (session.migration) return { ok: false, error: '请先完成版本迁移（待处理数据）后再提交' }
    const schema = schemaOf(session)
    if (!schema) return { ok: false, error: '锚定版本缺失，无法提交' }

    // 必填项兜底检查（按锚定版本的条件显隐判定，隐藏字段不拦提交）
    const validPaths = new Set(collectFields(schema.nodes).map(({ path }) => path))
    const pathById = new Map<string, string>()
    collectFields(schema.nodes).forEach(({ node, path }) => pathById.set(node.id, path))
    const walk = (items: typeof schema.nodes): string | null => {
      for (const node of items) {
        if (!evaluateCondition(node.condition, session.answers, validPaths).visible) continue
        if (node.type !== 'group' && node.type !== 'container') {
          const path = pathById.get(node.id)
          if (path && node.validation?.required && isValueEmpty(session.answers[path])) return node.label
        }
        const childError = walk(node.children ?? [])
        if (childError) return childError
      }
      return null
    }
    const missingLabel = walk(schema.nodes)
    if (missingLabel) {
      return { ok: false, error: `还有必填项未填写：${missingLabel}` }
    }

    const now = new Date().toISOString()
    const updated = updateSession(id, (target) => {
      target.status = 'submitted'
      target.submittedAt = now
    })
    return updated ? { ok: true } : { ok: false, error: persistError.value || '提交写入失败，答案未丢失' }
  }

  function removeSession(id: string) {
    const next = cloneSchema(doc.value)
    next.sessions = next.sessions.filter((item) => item.id !== id)
    if (commit(next) && activeId.value === id) activeId.value = next.sessions[0]?.id ?? null
  }

  return {
    sessions,
    activeSession,
    activeId,
    persistError,
    startSession,
    selectSession,
    revisionOf,
    schemaOf,
    isAhead,
    updateAnswer,
    beginMigration,
    retryMigration,
    cancelMigration,
    resolveConflict,
    submit,
    removeSession,
  }
})

