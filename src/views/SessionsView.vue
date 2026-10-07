<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshLeft, Warning } from '@element-plus/icons-vue'
import FormRenderer from '../components/FormRenderer.vue'
import { useRuntimeStore } from '../stores/runtime'
import type { RuntimeValueMap } from '../types/form'
import { validateValue, walkWithPaths } from '../utils/schema'

const runtime = useRuntimeStore()
const errors = reactive<Record<string, string>>({})
const migrating = ref(false)

const session = computed(() => runtime.currentSession)
const sessionSchema = computed(() => {
  if (!session.value) return undefined
  return runtime.versionById(session.value.versionId)?.schema
})

// 切换会话时清空错误提示
watch(() => session.value?.id, () => {
  Object.keys(errors).forEach((key) => delete errors[key])
})

function startSession(versionId: string) {
  runtime.startSession(versionId)
  ElMessage.success('已开始填写，答案将自动保存到本地')
}

function resumeSession(sessionId: string) {
  runtime.resumeSession(sessionId)
}

function updateValue(path: string, value: unknown) {
  if (!session.value) return
  runtime.saveAnswer(session.value.id, path, value)
}

function updateError(path: string, error: string) {
  if (error) errors[path] = error
  else delete errors[path]
}

function validateAll(): boolean {
  if (!sessionSchema.value) return false
  let valid = true
  walkWithPaths(sessionSchema.value.nodes).forEach(({ node, path }) => {
    if (node.type === 'group' || node.type === 'container') return
    const error = validateValue(session.value?.values[path], node.validation)
    if (error) {
      errors[path] = error
      valid = false
    }
  })
  return valid
}

function submit() {
  Object.keys(errors).forEach((key) => delete errors[key])
  if (!validateAll()) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  if (session.value) runtime.submitSession(session.value.id)
  ElMessage.success('提交成功，会话已标记为已提交')
}

async function doMigrate() {
  if (!session.value) return
  migrating.value = true
  // 让按钮 loading 生效，迁移本身是同步纯计算
  await Promise.resolve()
  const ok = runtime.migrateSession(session.value.id)
  migrating.value = false
  if (ok) ElMessage.success('答案已按字段路径迁移，对不上的答案已列为待处理')
  else ElMessage.error('迁移失败，原会话已保留，可重试')
}

function retry() {
  if (!session.value) return
  const ok = runtime.retryMigration(session.value.id)
  if (ok) ElMessage.success('迁移成功')
  else ElMessage.error('迁移仍失败，原会话已保留')
}

function resolve(path: string, action: 'keep_old' | 'use_new' | 'discard') {
  if (!session.value) return
  runtime.resolvePending(session.value.id, path, action)
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）'
  if (Array.isArray(value)) return `[表格 ${value.length} 行]`
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
</script>

<template>
  <div class="sessions-grid">
    <aside class="side-panel">
      <div class="panel-head">
        <span class="panel-title">发布版本</span>
        <span class="muted">{{ runtime.versions.length }} 个</span>
      </div>
      <div class="panel-scroll">
        <div v-if="!runtime.versions.length" class="muted" style="padding: 12px 4px">
          还没有发布版本，请先在设计器中发布。
        </div>
        <div v-for="version in runtime.versions" :key="version.id" class="version-card">
          <div class="version-top">
            <strong>v{{ version.number }}</strong>
            <span class="muted">{{ new Date(version.publishedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </div>
          <div class="muted" style="margin: 4px 0">{{ version.schema.title }}</div>
          <div v-if="version.note" class="muted">说明：{{ version.note }}</div>
          <el-button size="small" type="primary" plain style="margin-top: 8px" @click="startSession(version.id)">
            开始填写
          </el-button>
        </div>
      </div>

      <div class="panel-head" style="border-top: 1px solid #e5eaf0">
        <span class="panel-title">我的会话</span>
        <span class="muted">{{ runtime.sessions.length }} 个</span>
      </div>
      <div class="panel-scroll">
        <div v-if="!runtime.sessions.length" class="muted" style="padding: 12px 4px">暂无会话</div>
        <div
          v-for="item in runtime.sessions"
          :key="item.id"
          class="session-row"
          :class="{ active: item.id === session?.id }"
          @click="resumeSession(item.id)"
        >
          <div class="version-top">
            <strong>v{{ item.versionNumber }}</strong>
            <el-tag size="small" :type="item.status === 'submitted' ? 'success' : item.status === 'migration_failed' ? 'danger' : 'info'">
              {{ item.status === 'submitted' ? '已提交' : item.status === 'migration_failed' ? '迁移失败' : '填写中' }}
            </el-tag>
          </div>
          <div class="muted" style="margin-top: 2px">{{ new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) }}</div>
        </div>
      </div>
    </aside>

    <section class="canvas-panel">
      <div class="canvas-toolbar">
        <div class="toolbar-row">
          <template v-if="session">
            <strong>填写会话 · v{{ session.versionNumber }}</strong>
            <el-tag size="small" type="info">{{ session.status === 'submitted' ? '已提交' : '填写中' }}</el-tag>
            <span class="muted">开始于 {{ new Date(session.startedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </template>
          <span v-else class="muted">选择一个发布版本开始填写</span>
        </div>
        <el-button v-if="session" type="primary" @click="submit">提交</el-button>
      </div>

      <div class="canvas-scroll">
        <div v-if="session && sessionSchema" class="form-canvas">
          <!-- 新版本迁移提示 -->
          <el-alert
            v-if="runtime.hasNewVersion && session.status !== 'migration_failed'"
            type="warning"
            :closable="false"
            show-icon
            style="margin-bottom: 16px"
          >
            <template #title>
              有新版本 v{{ runtime.latestVersion?.number }} 可用，已填答案可按字段路径迁移。
              <el-button size="small" type="warning" plain :loading="migrating" style="margin-left: 8px" @click="doMigrate">
                迁移答案到 v{{ runtime.latestVersion?.number }}
              </el-button>
            </template>
          </el-alert>

          <!-- 迁移失败提示 -->
          <el-alert
            v-if="session.status === 'migration_failed'"
            type="error"
            :closable="false"
            show-icon
            style="margin-bottom: 16px"
            :title="`迁移失败：${session.migrationError ?? '未知错误'}。原会话答案已保留，可重试。`"
          >
            <template #default>
              <el-button size="small" type="danger" plain style="margin-top: 8px" @click="retry">
                <el-icon><RefreshLeft /></el-icon>
                重试迁移
              </el-button>
            </template>
          </el-alert>

          <h1>{{ sessionSchema.title }}</h1>
          <p>{{ sessionSchema.description }}</p>

          <FormRenderer
            :nodes="sessionSchema.nodes"
            :values="session.values"
            :errors="errors"
            @update="updateValue"
            @error="updateError"
          />

          <el-button type="primary" size="large" @click="submit">提交表单</el-button>

          <!-- 待处理答案 -->
          <div v-if="session.pendingAnswers.length" class="pending-box">
            <div class="pending-title">
              <el-icon><Warning /></el-icon>
              待处理答案（{{ session.pendingAnswers.length }}）
            </div>
            <div v-for="pending in session.pendingAnswers" :key="pending.path" class="pending-row">
              <div class="pending-path">{{ pending.label }} <span class="muted">{{ pending.path }}</span></div>
              <div class="pending-detail">{{ pending.detail }}</div>
              <div class="pending-values">
                <span class="pending-old">原答案：{{ formatValue(pending.oldValue) }}</span>
                <el-icon class="pending-arrow"><RefreshLeft /></el-icon>
                <span class="pending-new">新默认值：{{ formatValue(pending.newValue) }}</span>
              </div>
              <div class="pending-actions">
                <el-button size="small" @click="resolve(pending.path, 'keep_old')">采用原答案</el-button>
                <el-button size="small" type="primary" plain @click="resolve(pending.path, 'use_new')">采用新值</el-button>
                <el-button size="small" text @click="resolve(pending.path, 'discard')">保留待处理</el-button>
              </div>
            </div>
          </div>

          <div class="summary-box">
            已填 {{ Object.keys(session.values).length }} 项；待处理 {{ session.pendingAnswers.length }} 项。
            <span v-if="runtime.saveError" class="save-error"> {{ runtime.saveError }}</span>
          </div>
        </div>

        <div v-else class="empty-canvas">
          <strong>还没有开始填写</strong>
          从左侧选择一个发布版本开始
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sessions-grid {
  height: 100%;
  display: grid;
  grid-template-columns: 300px minmax(560px, 1fr);
  gap: 1px;
  background: #dce3ec;
}
.version-card {
  padding: 11px 12px;
  margin-bottom: 10px;
  border: 1px solid #dfe6ef;
  border-radius: 7px;
  background: #f8fafc;
}
.version-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.session-row {
  padding: 9px 11px;
  margin-bottom: 8px;
  border: 1px solid #dfe6ef;
  border-radius: 7px;
  cursor: pointer;
  transition: .12s ease;
}
.session-row:hover { border-color: #60a5fa; background: #f0f7ff; }
.session-row.active { border-color: #409eff; background: #eaf3ff; }
.pending-box {
  margin-top: 22px;
  padding: 14px;
  border: 1px solid #f5dab1;
  border-radius: 8px;
  background: #fdf6ec;
}
.pending-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: #b88230;
  font-weight: 700;
  font-size: 13px;
}
.pending-row {
  padding: 10px 0;
  border-top: 1px dashed #f0d9b5;
}
.pending-path { font-weight: 650; color: #5e4a2e; font-size: 13px; }
.pending-detail { margin: 4px 0; color: #8a7350; font-size: 12px; }
.pending-values { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b5d44; }
.pending-old { color: #b88230; }
.pending-new { color: #526176; }
.pending-arrow { color: #c0b090; }
.pending-actions { margin-top: 8px; display: flex; gap: 6px; }
.save-error { color: #e5484d; }
</style>
