import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FormSchema, PublishedRevision } from '../types/form'
import { RELEASE_KEY, initWorkspace } from './workspace'
import { cloneSchema } from '../utils/schema'
import { writeAtomic } from '../utils/storage'

export const useReleaseStore = defineStore('release', () => {
  const workspace = initWorkspace()
  const release = ref(workspace.release)
  const persistError = ref('')

  const revisions = computed(() => release.value.revisions)
  const latestRevision = computed<PublishedRevision | null>(
    () => release.value.revisions[release.value.revisions.length - 1] ?? null,
  )
  const draftBaseline = computed(() => release.value.draftBaseline)

  function persist(): boolean {
    try {
      writeAtomic(RELEASE_KEY, release.value)
      persistError.value = ''
      return true
    } catch (error) {
      persistError.value = error instanceof Error ? error.message : '发布版本写入失败'
      return false
    }
  }

  /** 发布：冻结当前草稿的字段结构、校验与联动条件，生成不可变版本 */
  function publish(schema: FormSchema, note?: string): PublishedRevision {
    const frozen: FormSchema = cloneSchema(schema)
    frozen.updatedAt = new Date().toISOString()
    const nextRev = (latestRevision.value?.rev ?? 0) + 1
    const revision: PublishedRevision = { rev: nextRev, schema: frozen, publishedAt: frozen.updatedAt, note }

    const next = cloneSchema(release.value)
    next.revisions.push(revision)
    next.draftBaseline = nextRev
    try {
      writeAtomic(RELEASE_KEY, next)
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '发布写入失败，版本未创建')
    }
    release.value = next
    persistError.value = ''
    return revision
  }

  /** 导入外部 Schema 后草稿不再对应任何发布版本 */
  function clearBaseline() {
    const next = cloneSchema(release.value)
    next.draftBaseline = null
    if (persistDoc(next)) release.value = next
  }

  function persistDoc(doc = release.value): boolean {
    try {
      writeAtomic(RELEASE_KEY, doc)
      return true
    } catch {
      return false
    }
  }

  function getRevision(rev: number): PublishedRevision | undefined {
    return release.value.revisions.find((item) => item.rev === rev)
  }

  return {
    revisions,
    latestRevision,
    draftBaseline,
    persistError,
    publish,
    clearBaseline,
    persist,
    getRevision,
  }
})
