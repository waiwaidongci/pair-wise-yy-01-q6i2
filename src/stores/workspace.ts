import type { FillSession, FormSchema, ReleaseDoc, SessionsDoc } from '../types/form'
import { readDoc, writeAtomic, removeDoc } from '../utils/storage'
import { buildDefaultValues, cloneSchema, createStarterSchema, normalizeSchema } from '../utils/schema'

export const LEGACY_DRAFT_KEY = 'formcraft-schema-v1'
export const DRAFT_KEY = 'formcraft-draft-v2'
export const RELEASE_KEY = 'formcraft-release-v2'
export const SESSIONS_KEY = 'formcraft-sessions-v2'

function isSession(value: unknown): value is FillSession {
  const candidate = value as FillSession
  return !!candidate && typeof candidate.id === 'string' && typeof candidate.revId === 'number'
    && typeof candidate.answers === 'object' && candidate.answers !== null
}

function isSessionsDoc(value: unknown): value is SessionsDoc {
  return !!value && Array.isArray((value as SessionsDoc).sessions)
    && (value as SessionsDoc).sessions.every(isSession)
}

function isReleaseDoc(value: unknown): value is ReleaseDoc {
  const candidate = value as ReleaseDoc
  return !!candidate && Array.isArray(candidate.revisions)
    && candidate.revisions.every((item) => typeof item.rev === 'number' && !!item.schema && Array.isArray(item.schema.nodes))
    && (candidate.draftBaseline === null || typeof candidate.draftBaseline === 'number')
}

function createDemoSession(revId: number, schema: FormSchema): FillSession {
  const now = new Date().toISOString()
  const answers = {
    ...buildDefaultValues(schema.nodes),
    applicantName: '李雷',
    requestType: '差旅报销',
    'reasonSection.detail': '客户现场交付支持，需出差三天',
    expenses: [{ name: '高铁票', amount: '530', date: '2026-10-10' }],
  }
  return {
    id: `session_demo`,
    revId,
    status: 'open',
    answers,
    startedAt: now,
    updatedAt: now,
    migration: null,
    retainedAnswers: [],
  }
}

export interface Workspace {
  release: ReleaseDoc
  sessions: SessionsDoc
  draft: FormSchema
}

let cached: Workspace | null = null

/**
 * 读取并初始化工作区：
 * 已发布版本与填单会话分别持久化；首次进入播种一份 v1 演示发布版本与进行中会话；
 * 老版本（仅一份草稿）的本地数据归一化为新草稿，不自动发布。
 */
export function initWorkspace(): Workspace {
  if (cached) return cached

  let release = readDoc<ReleaseDoc>(RELEASE_KEY, isReleaseDoc)
  let sessions = readDoc<SessionsDoc>(SESSIONS_KEY, isSessionsDoc)
  if (sessions) {
    // 兼容早期会话文档：补齐保留答案字段
    sessions.sessions.forEach((item) => {
      if (!Array.isArray(item.retainedAnswers)) item.retainedAnswers = []
    })
  }
  const storedDraft = (() => {
    const raw = readDoc<unknown>(DRAFT_KEY, (value): value is unknown => value !== null && typeof value === 'object')
    return raw ? normalizeSchema(raw) : null
  })()

  let draft: FormSchema
  let seeded = false

  if (release) {
    sessions ??= { sessions: [] }
    const latest = release.revisions[release.revisions.length - 1]
    draft = storedDraft ?? (latest ? cloneSchema(latest.schema) : createStarterSchema())
  } else {
    let legacy: FormSchema | null = null
    try {
      const raw = localStorage.getItem(LEGACY_DRAFT_KEY)
      legacy = raw ? normalizeSchema(JSON.parse(raw)) : null
    } catch {
      legacy = null
    }

    if (legacy) {
      release = { revisions: [], draftBaseline: null }
      sessions ??= { sessions: [] }
      draft = storedDraft ?? legacy
    } else {
      const revisionSchema = createStarterSchema()
      const now = new Date().toISOString()
      revisionSchema.updatedAt = now
      release = { revisions: [{ rev: 1, schema: revisionSchema, publishedAt: now, note: '首次发布（演示数据）' }], draftBaseline: 1 }
      sessions ??= { sessions: [createDemoSession(1, revisionSchema)] }
      draft = cloneSchema(revisionSchema)
      seeded = true
    }
  }

  // 初始化即落盘，保证发布版本、会话、草稿三份文档都完整存在
  try {
    writeAtomic(RELEASE_KEY, release)
    writeAtomic(SESSIONS_KEY, sessions)
    writeAtomic(DRAFT_KEY, draft)
    if (localStorage.getItem(LEGACY_DRAFT_KEY)) removeDoc(LEGACY_DRAFT_KEY)
  } catch {
    // 持久化失败时仍可在内存中继续；后续写操作会再次尝试
  }
  void seeded

  cached = { release, sessions, draft }
  return cached
}
