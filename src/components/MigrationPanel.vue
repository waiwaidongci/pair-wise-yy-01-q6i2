<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, RefreshLeft } from '@element-plus/icons-vue'
import type { FillSession, FormSchema } from '../types/form'
import { useSessionsStore } from '../stores/sessions'
import { collectFields } from '../utils/schema'

const props = defineProps<{
  session: FillSession
  targetSchema: FormSchema
}>()

const sessionsStore = useSessionsStore()
const migration = computed(() => props.session.migration!)
const targetFields = computed(() => collectFields(props.targetSchema.nodes))
const chosen = ref<Record<string, string>>({})

function fieldLabel(path: string): string {
  const field = targetFields.value.find((item) => item.path === path)
  return field ? `${field.node.label}（${path}）` : path
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} 行明细]`
  const text = String(value ?? '')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function applyMap(conflictId: string) {
  const targetPath = chosen.value[conflictId]
  if (!targetPath) {
    ElMessage.warning('请先选择要补入的新字段路径')
    return
  }
  const result = sessionsStore.resolveConflict(props.session.id, conflictId, 'map', targetPath)
  if (!result.ok) ElMessage.error(result.error)
  else ElMessage.success('旧答案已按字段路径补入')
}

function keepAside(conflictId: string) {
  const result = sessionsStore.resolveConflict(props.session.id, conflictId, 'retain')
  if (!result.ok) ElMessage.error(result.error)
  else ElMessage.success('两边值均已保留，列为待处理数据，可稍后查看')
}

function retry() {
  const result = sessionsStore.retryMigration(props.session.id)
  if (!result.ok) ElMessage.error(result.error)
  else ElMessage.info('已回到开始时版本并重新规划迁移')
}
</script>

<template>
  <el-alert
    type="warning"
    :closable="false"
    show-icon
    style="margin-bottom: 14px"
    :title="`表单发布了新版本 v${migration.targetRev}，本会话开始于 v${migration.fromRev}`"
  >
    <template #default>
      <div>
        {{ migration.matchedCount }} 个字段已按路径直接补入；{{ migration.conflicts.length }} 条旧答案对不上，处理完才能提交。
        原始答案已随会话保留，写入中断可随时重试，不会丢失已录数据。
        <el-button size="small" style="margin-top: 8px" @click="retry">
          <el-icon><RefreshLeft /></el-icon>
          放弃迁移并恢复 v{{ migration.fromRev }} 重算
        </el-button>
      </div>
    </template>
  </el-alert>

  <div class="conflict-list">
    <el-card v-for="conflict in migration.conflicts" :key="conflict.id" class="conflict-card" shadow="never">
      <div class="conflict-head">
        <el-tag size="small" :type="conflict.reason === 'type_changed' ? 'danger' : 'warning'">
          {{ conflict.reason === 'type_changed' ? '同路径类型/表格结构变化' : '字段已删除或改名' }}
        </el-tag>
        <strong>{{ conflict.oldLabel }}</strong>
        <span class="muted">{{ conflict.oldPath }}</span>
      </div>
      <div class="conflict-value">旧值：<code>{{ valueText(conflict.value) }}</code></div>
      <div v-if="conflict.reason === 'type_changed'" class="muted">
        同路径新字段「{{ conflict.newLabel }}」类型不一致，两边值都保留，请指定补入字段或列入待处理。
      </div>
      <div v-if="conflict.candidates.length" class="conflict-actions">
        <el-select
          :model-value="chosen[conflict.id]"
          placeholder="选择同类型的新字段"
          style="width: 300px"
          @update:model-value="chosen[conflict.id] = $event"
        >
          <el-option
            v-for="path in conflict.candidates"
            :key="path"
            :label="fieldLabel(path)"
            :value="path"
          />
        </el-select>
        <el-button size="small" type="primary" plain @click="applyMap(conflict.id)">
          <el-icon><Connection /></el-icon>
          补入该字段
        </el-button>
        <el-button size="small" @click="keepAside(conflict.id)">两边保留，列待处理</el-button>
      </div>
      <div v-else class="conflict-actions">
        <span class="muted">新版本没有同类型字段可补入</span>
        <el-button size="small" @click="keepAside(conflict.id)">两边保留，列待处理</el-button>
      </div>
    </el-card>
  </div>

  <el-card v-if="migration.retained.length" class="retained-card" shadow="never">
    <template #header><strong>已保留的待处理数据（不会随提交丢弃）</strong></template>
    <div v-for="(item, index) in migration.retained" :key="`${item.oldPath}-${index}`" class="retained-row">
      <span>{{ item.label }}</span>
      <span class="muted">{{ item.oldPath }}</span>
      <code>{{ valueText(item.value) }}</code>
    </div>
  </el-card>
</template>
