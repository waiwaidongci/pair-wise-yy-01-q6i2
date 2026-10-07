<script setup lang="ts">
import { computed } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, isContainerType, joinPath, validateValue } from '../utils/schema'

const props = withDefaults(defineProps<{
  node: FieldNode
  values: RuntimeValueMap
  errors: Record<string, string>
  validPaths: Set<string>
  /** 祖先分组/容器段组成的父路径 */
  parentPath?: string
}>(), { parentPath: '' })

const emit = defineEmits<{
  update: [fieldPath: string, value: unknown]
  error: [fieldPath: string, error: string]
}>()

const fieldPath = computed(() => joinPath(props.parentPath, props.node.name))
const isContainer = computed(() => isContainerType(props.node.type))
const conditionEval = computed(() => evaluateCondition(props.node.condition, props.values, props.validPaths))
const visible = computed(() => conditionEval.value.visible)
const broken = computed(() => conditionEval.value.broken)

const tableRows = computed(() => {
  const value = props.values[fieldPath.value]
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : []
})

function update(value: unknown) {
  emit('update', fieldPath.value, value)
  const error = validateValue(value, props.node.validation)
  emit('error', fieldPath.value, error ?? '')
}

function addTableRow() {
  const next = [...tableRows.value, Object.fromEntries((props.node.columns ?? []).map((column) => [column.key, '']))]
  update(next)
}

function updateTableValue(rowIndex: number, key: string, value: unknown) {
  const next = tableRows.value.map((row, index) => index === rowIndex ? { ...row, [key]: value } : { ...row })
  update(next)
}

function removeTableRow(rowIndex: number) {
  update(tableRows.value.filter((_, index) => index !== rowIndex))
}
</script>

<template>
  <template v-if="visible">
    <div v-if="isContainer" class="runtime-container">
      <div class="runtime-label">
        {{ node.label }}
        <el-tooltip v-if="broken" content="联动目标字段标识已变更，条件失效（字段已隐藏，改标识或重选条件后恢复）" placement="top">
          <el-tag size="small" type="danger" effect="light">联动失效</el-tag>
        </el-tooltip>
      </div>
      <RuntimeField
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :values="values"
        :errors="errors"
        :valid-paths="validPaths"
        :parent-path="fieldPath"
        @update="(path, value) => emit('update', path, value)"
        @error="(path, error) => emit('error', path, error)"
      />
    </div>
    <div v-else class="runtime-field">
      <div class="runtime-label">
        {{ node.label }}
        <span v-if="node.validation?.required" class="required-dot">*</span>
        <el-tooltip v-if="broken" content="联动目标字段标识已变更，条件已失效并隐藏本字段" placement="top">
          <el-tag size="small" type="danger" effect="light">联动失效</el-tag>
        </el-tooltip>
        <span class="field-path-hint">{{ fieldPath }}</span>
      </div>
      <el-input
        v-if="node.type === 'input'"
        :model-value="values[fieldPath] as string"
        :placeholder="node.placeholder"
        @update:model-value="update"
      />
      <el-select
        v-else-if="node.type === 'select'"
        :model-value="values[fieldPath]"
        :placeholder="node.placeholder"
        style="width: 100%"
        @update:model-value="update"
      >
        <el-option v-for="option in node.options" :key="option" :label="option" :value="option" />
      </el-select>
      <el-date-picker
        v-else-if="node.type === 'date'"
        :model-value="values[fieldPath] as string"
        type="date"
        value-format="YYYY-MM-DD"
        :placeholder="node.placeholder"
        style="width: 100%"
        @update:model-value="update"
      />
      <div v-else-if="node.type === 'table'" class="runtime-table">
        <div class="runtime-table-row head">
          <div v-for="column in node.columns" :key="column.key" class="runtime-table-cell">{{ column.label }}</div>
          <div class="runtime-table-cell" style="max-width: 70px">操作</div>
        </div>
        <div v-for="(row, rowIndex) in tableRows" :key="rowIndex" class="runtime-table-row">
          <div v-for="column in node.columns" :key="column.key" class="runtime-table-cell">
            <el-input
              :model-value="row[column.key] as string"
              size="small"
              @update:model-value="updateTableValue(rowIndex, column.key, $event)"
            />
          </div>
          <div class="runtime-table-cell" style="max-width: 70px">
            <el-button link type="danger" @click="removeTableRow(rowIndex)">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
        <div v-if="!tableRows.length" class="muted table-empty">暂无明细行</div>
        <div style="padding: 8px">
          <el-button size="small" plain @click="addTableRow">
            <el-icon><Plus /></el-icon>
            添加明细
          </el-button>
        </div>
      </div>
      <div v-if="errors[fieldPath]" class="error-text">{{ errors[fieldPath] }}</div>
    </div>
  </template>
</template>
