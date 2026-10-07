import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FormSchema, FormSession, PublishedVersion } from '../types/form'
import { freezeSchema, migrateAnswers } from '../utils/schema'
import { createId } from '../utils/id'

const VERSIONS_KEY = 'formcraft-versions-v1'
const SESSIONS_KEY = 'formcraft-sessions-v1'

function loadVersions(): PublishedVersion[] {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY)
    if (raw) return JSON.parse(raw) as PublishedVersion[]
  } catch {
    // 忽略损坏的本地数据
  }
  return []
}

function loadSessions(): FormSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (raw) return JSON.parse(raw) as FormSession[]
  } catch {
    // 忽略损坏的本地数据
  }
  return []
}

export const useRuntimeStore = defineStore('runtime', () => {
  const versions = ref<PublishedVersion[]>(loadVersions())
  const sessions = ref<FormSession[]>(loadSessions())
  const currentSessionId = ref<string | null>(null)
  const saveError = ref<string | null>(null)

  const currentSession = computed(() => sessions.value.find((session) => session.id === currentSessionId.value))
  const latestVersion = computed(() => versions.value.length ? versions.value[versions.value.length - 1] : undefined)
  const hasNewVersion = computed(() => {
    const session = currentSession.value
    const latest = latestVersion.value
    return !!session && !!latest && session.versionId !== latest.id
  })

  function persistVersions() {
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions.value))
    } catch {
      // 版本写入失败时仍保留在内存中，可重试
    }
  }

  /** 写直通：每次答案变更都立即落盘；写入失败时答案仍保留在内存中，不丢失 */
  function persistSession() {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.value))
      saveError.value = null
    } catch {
      saveError.value = '本地写入失败，答案仍保留在当前会话中，请稍后重试'
    }
  }

  function flushSession() {
    persistSession()
  }

  /** 发布：冻结当前草稿为一个不可变版本，草稿继续独立编辑 */
  function publishVersion(schema: FormSchema, note = ''): PublishedVersion {
    const number = (versions.value[versions.value.length - 1]?.number ?? 0) + 1
    const version: PublishedVersion = {
      id: createId('version'),
      number,
      schema: freezeSchema(schema),
      publishedAt: new Date().toISOString(),
      note,
    }
    versions.value.push(version)
    persistVersions()
    return version
  }

  function versionById(id: string): PublishedVersion | undefined {
    return versions.value.find((version) => version.id === id)
  }

  /** 开始填写：基于指定冻结版本创建会话，之后按该版本恢复与判断 */
  function startSession(versionId: string): FormSession {
    const version = versionById(versionId)
    if (!version) throw new Error('发布版本不存在')
    const session: FormSession = {
      id: createId('session'),
      versionId,
      versionNumber: version.number,
      status: 'in_progress',
      values: {},
      pendingAnswers: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    sessions.value.push(session)
    persistSession()
    currentSessionId.value = session.id
    return session
  }

  function resumeSession(sessionId: string) {
    currentSessionId.value = sessionId
  }

  /** 写答案：按字段路径记录，立即落盘 */
  function saveAnswer(sessionId: string, path: string, value: unknown) {
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return
    session.values[path] = value
    session.updatedAt = new Date().toISOString()
    if (session.status === 'migration_failed') session.status = 'in_progress'
    persistSession()
  }

  /**
   * 迁移会话答案到目标版本。
   * 先纯计算迁移结果，成功后再提交；失败则原会话保留并标记可重试。
   */
  function migrateSession(sessionId: string, targetVersionId?: string): boolean {
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return false
    const target = targetVersionId ? versionById(targetVersionId) : latestVersion.value
    if (!target) {
      session.status = 'migration_failed'
      session.migrationError = '没有可迁移的目标版本'
      persistSession()
      return false
    }
    const oldVersion = versionById(session.versionId)
    if (!oldVersion) {
      session.status = 'migration_failed'
      session.migrationError = '原版本快照缺失，无法迁移；原会话答案已保留，可重试'
      persistSession()
      return false
    }
    try {
      const result = migrateAnswers(oldVersion.schema, target.schema, session.values)
      // 事务性提交：迁移计算成功后才切换版本与答案
      session.values = result.values
      session.pendingAnswers = result.pending
      session.versionId = target.id
      session.versionNumber = target.number
      session.status = 'in_progress'
      session.migrationError = undefined
      session.lastMigratedAt = new Date().toISOString()
      session.updatedAt = new Date().toISOString()
      persistSession()
      return true
    } catch (error) {
      session.status = 'migration_failed'
      session.migrationError = error instanceof Error ? error.message : '迁移失败，原会话已保留，可重试'
      persistSession()
      return false
    }
  }

  function retryMigration(sessionId: string) {
    return migrateSession(sessionId)
  }

  /** 处理待处理答案：采用旧值补入新路径 / 采用新值 / 保留待处理 */
  function resolvePending(sessionId: string, path: string, action: 'keep_old' | 'use_new' | 'discard') {
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return
    const pending = session.pendingAnswers.find((item) => item.path === path)
    if (!pending) return
    if (action === 'keep_old') {
      const target = versionById(session.versionId)
      const exists = target && JSON.stringify(target.schema).includes(`"name":"${path.split('/').pop()}"`)
      if (exists) session.values[path] = pending.oldValue
    } else if (action === 'use_new') {
      if (pending.newValue !== undefined) session.values[path] = pending.newValue
    }
    session.pendingAnswers = session.pendingAnswers.filter((item) => item.path !== path)
    session.updatedAt = new Date().toISOString()
    persistSession()
  }

  function submitSession(sessionId: string) {
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return
    session.status = 'submitted'
    session.submittedAt = new Date().toISOString()
    session.updatedAt = new Date().toISOString()
    persistSession()
  }

  return {
    versions,
    sessions,
    currentSessionId,
    currentSession,
    latestVersion,
    hasNewVersion,
    saveError,
    publishVersion,
    versionById,
    startSession,
    resumeSession,
    saveAnswer,
    migrateSession,
    retryMigration,
    resolvePending,
    submitSession,
    flushSession,
    persistSession,
  }
})
