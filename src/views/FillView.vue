<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentAdd } from '@element-plus/icons-vue'
import RuntimeField from '../components/RuntimeField.vue'
import MigrationPanel from '../components/MigrationPanel.vue'
import { useSessionsStore } from '../stores/sessions'
import { useReleaseStore } from '../stores/release'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { collectFields, evaluateCondition, validateValue } from '../utils/schema'

const sessionsStore = useSessionsStore()
const releaseStore = useReleaseStore()
const errors = reactive<Record<string, string>>({})

const session = computed(() => sessionsStore.activeSession)

/** 进行中迁移按目标版本渲染，否则始终按会话锚定（开始时）版本恢复 */
const activeSchema = computed(() => {
  if (!session.value) return null
  if (session.value.migration) return releaseStore.getRevision(session.value.migration.targetRev)?.schema ?? null
  return sessionsStore.schemaOf(session.value)
})
const activeRevision = computed(() => {
  if (!session.value) return null
  const revId = session.value.migration?.targetRev ?? session.value.revId
  return releaseStore.getRevision(revId) ?? null
})
const validPaths = computed(() => activeSchema.value ? new Set(collectFields(activeSchema.value.nodes).map(({ path }) => path)) : new Set<string>())
const pathById = computed(() => {
  const map = new Map<string, string>()
  if (activeSchema.value) collectFields(activeSchema.value.nodes).forEach(({ node, path }) => map.set(node.id, path))
  return map
})
const answers = computed<RuntimeValueMap>(() => session.value?.answers ?? {})
const migrating = computed(() => !!session.value?.migration)

// 切换会话时清空校验提示
watch(() => sessionsStore.activeId, () => Object.keys(errors).forEach((key) => delete errors[key]))

function updateValue(path: string, value: unknown) {
  if (!session.value) return
  if (migrating.value) {
    // 迁移期间允许继续填写新版本字段，写入同样原子持久化
    if (!sessionsStore.updateAnswer(session.value.id, path, value)) ElMessage.error('写入失败，上一版答案已保留')
    return
  }
  if (!sessionsStore.updateAnswer(session.value.id, path, value)) ElMessage.error('写入失败，已保留此前答案')
}

function updateError(path: string, error: string) {
  if (error) errors[path] = error
  else delete errors[path]
}

function validateAll(items: FieldNode[]): boolean {
  let valid = true
  items.forEach((node) => {
    if (!evaluateCondition(node.condition, answers.value, validPaths.value).visible) return
    if (node.type !== 'group' && node.type !== 'container') {
      const path = pathById.value.get(node.id)
      if (path) {
        const error = validateValue(answers.value[path], node.validation)
        if (error) {
          errors[path] = error
          valid = false
        } else delete errors[path]
      }
    }
    if (!validateAll(node.children ?? [])) valid = false
  })
  return valid
}

async function startSession() {
  try {
    await ElMessageBox.confirm(
      `将基于最新发布版本 v${releaseStore.latestRevision?.rev} 开始填写，会话会锚定该版本：之后设计器发布新版本不影响本会话。`,
      '开始新的填单会话',
      { confirmButtonText: '开始填写', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    sessionsStore.startSession()
    ElMessage.success('已按最新发布版本创建会话')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败')
  }
}

async function migrate() {
  if (!session.value) return
  const result = sessionsStore.beginMigration(session.value.id)
  if (!result.ok) ElMessage.error(result.error)
  else ElMessage.success('已按新版本迁移，匹配字段直接补入，剩余项请处理')
}

async function submit() {
  if (!session.value || !activeSchema.value) return
  if (migrating.value) {
    ElMessage.warning('请先处理完待迁移的旧答案，再提交表单')
    return
  }
  Object.keys(errors).forEach((key) => delete errors[key])
  if (!validateAll(activeSchema.value.nodes)) {
    ElMessage.error('校验未通过，请检查红色提示')
    return
  }
  const result = sessionsStore.submit(session.value.id)
  if (!result.ok) ElMessage.error(result.error)
  else ElMessage.success('已按会话版本校验并提交')
}

function versionTag(revId: number) {
  return `v${revId}`
}

function valuePreview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} 行明细]`
  const text = String(value ?? '')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}
</script>

<template>
  <div class="fill-layout">
    <aside class="fill-sessions">
      <div class="panel-head">
        <span class="panel-title">填单会话</span>
        <el-button size="small" type="primary" @click="startSession">
          <el-icon><DocumentAdd /></el-icon>
          新会话
        </el-button>
      </div>
      <div class="panel-scroll">
        <div
          v-for="item in sessionsStore.sessions"
          :key="item.id"
          class="session-item"
          :class="{ active: item.id === sessionsStore.activeId }"
          @click="sessionsStore.selectSession(item.id)"
        >
          <div class="session-item-row">
            <el-tag size="small" effect="plain">{{ versionTag(item.revId) }}</el-tag>
            <el-tag size="small" :type="item.status === 'submitted' ? 'success' : 'warning'">
              {{ item.status === 'submitted' ? '已提交' : '进行中' }}
            </el-tag>
            <el-tag v-if="item.migration" size="small" type="danger">迁移待处理</el-tag>
          </div>
          <div class="muted">开始于 {{ new Date(item.startedAt).toLocaleString('zh-CN') }}</div>
          <div v-if="sessionsStore.isAhead(item) && item.status === 'open' && !item.migration" class="muted ahead-hint">
            已有更新发布版本，可迁移
          </div>
        </div>
        <div v-if="!sessionsStore.sessions.length" class="muted" style="padding: 20px; text-align: center">
          还没有会话，点击「新会话」开始填写
        </div>
      </div>
    </aside>

    <section class="fill-main">
      <div v-if="!session" class="fill-empty">请选择或创建一个填单会话</div>
      <div v-else-if="!activeSchema || !activeRevision" class="fill-empty">
        会话锚定的发布版本缺失，无法恢复。会话数据仍保留在本地。
      </div>
      <div v-else class="preview-wrap fill-scroll">
        <div class="preview-card">
          <div class="fill-card-head">
            <div>
              <h1>{{ activeSchema.title }}</h1>
              <p>{{ activeSchema.description }}</p>
            </div>
            <div class="fill-version">
              <el-tag type="info" effect="plain">
                {{ migrating ? `迁移中：v${session.migration?.fromRev} → v${session.migration?.targetRev}` : `锚定 ${versionTag(session.revId)}` }}
              </el-tag>
              <el-tag :type="session.status === 'submitted' ? 'success' : 'warning'" effect="plain">
                {{ session.status === 'submitted' ? '已提交' : '进行中' }}
              </el-tag>
            </div>
          </div>

          <MigrationPanel v-if="migrating" :session="session" :target-schema="activeSchema" />

          <el-alert
            v-else-if="sessionsStore.isAhead(session) && session.status === 'open'"
            type="warning"
            :closable="false"
            show-icon
            style="margin-bottom: 14px"
            title="本表单已发布新版本，但本会话仍按开始时版本运行"
            description="继续填写不受影响；准备好后可迁移答案，匹配字段直接补入，对不上的值两边保留并列为待处理。"
          >
            <el-button size="small" type="primary" style="margin-top: 8px" @click="migrate">迁移到最新版本</el-button>
          </el-alert>

          <RuntimeField
            v-for="node in activeSchema.nodes"
            :key="node.id"
            :node="node"
            :values="answers"
            :errors="errors"
            :valid-paths="validPaths"
            @update="updateValue"
            @error="updateError"
          />

          <el-card v-if="session.retainedAnswers.length" class="retained-card" shadow="never">
            <template #header><strong>迁移中保留的待处理旧值（两边都保留，不随提交丢失）</strong></template>
            <div v-for="(item, index) in session.retainedAnswers" :key="`${item.oldPath}-${index}`" class="retained-row">
              <el-tag size="small" :type="item.reason === 'type_changed' ? 'danger' : 'warning'">
                {{ item.reason === 'type_changed' ? '类型变化' : '字段缺失' }}
              </el-tag>
              <span>{{ item.label }}</span>
              <span class="muted">{{ item.oldPath }}</span>
              <code>{{ valuePreview(item.value) }}</code>
            </div>
          </el-card>

          <el-button
            v-if="session.status === 'open'"
            type="primary"
            size="large"
            :disabled="migrating"
            @click="submit"
          >
            提交表单
          </el-button>
          <el-alert
            v-else
            type="success"
            :closable="false"
            show-icon
            :title="`已提交于 ${new Date(session.submittedAt ?? '').toLocaleString('zh-CN')}，按 v${session.revId} 校验通过`"
            style="margin-top: 18px"
          />
        </div>
      </div>
    </section>
  </div>
</template>
