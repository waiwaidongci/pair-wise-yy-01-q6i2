<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FieldNode, VisibilityCondition } from '../types/form'
import { useDesignerStore } from '../stores/designer'

const store = useDesignerStore()
const node = computed(() => store.selectedNode)
const optionText = ref('')
const columnText = ref('')
const nameDraft = ref('')
const nameError = ref('')

watch(node, (value) => {
  optionText.value = value?.options?.join('\n') ?? ''
  columnText.value = value?.columns?.map((item) => `${item.key}:${item.label}`).join('\n') ?? ''
  nameDraft.value = value?.name ?? ''
  nameError.value = ''
}, { immediate: true })

function patch(patchValue: Partial<FieldNode>) {
  store.updateSelected(patchValue)
}

function commitName() {
  if (!node.value) return
  const next = nameDraft.value.trim()
  if (next === node.value.name) {
    nameError.value = ''
    nameDraft.value = node.value.name
    return
  }
  const error = store.renameField(node.value.id, next)
  if (error) {
    nameError.value = error
    ElMessage.warning(error)
    // 标识非法：回到生效中的旧值，避免 UI 误以为已修改
    nameDraft.value = node.value.name
    return
  }
  nameError.value = ''
  ElMessage.success('字段标识已更新，相关联动条件已重算')
}

function patchValidation(key: keyof NonNullable<FieldNode['validation']>, value: unknown) {
  store.updateValidation({ [key]: value })
}

function optionsChanged() {
  const options = optionText.value.split('\n').map((item) => item.trim()).filter(Boolean)
  patch({ options })
}

function columnsChanged() {
  const columns = columnText.value.split('\n').map((line) => {
    const [key, ...labelParts] = line.split(':')
    return { key: key.trim(), label: labelParts.join(':').trim() || key.trim(), type: 'text' as const }
  }).filter((item) => item.key)
  patch({ columns })
}

function clearCondition() {
  store.updateSelected({ condition: undefined })
}

function setConditionField(fieldPath: string) {
  const condition: VisibilityCondition = {
    fieldPath,
    operator: node.value?.condition?.operator ?? 'equals',
    value: node.value?.condition?.value ?? '',
  }
  patch({ condition })
}

const conditionBroken = computed(() => {
  const path = node.value?.condition?.fieldPath
  return !!path && !store.fieldPaths.has(path)
})
</script>

<template>
  <aside class="side-panel">
    <div class="panel-head">
      <span class="panel-title">属性配置</span>
      <span class="muted">{{ node?.type ?? '未选择' }}</span>
    </div>
    <div v-if="node" class="panel-scroll">
      <section class="property-group">
        <h4>基础属性</h4>
        <el-form label-position="top" size="small">
          <el-form-item class="form-item-compact" label="显示标题">
            <el-input :model-value="node.label" @update:model-value="patch({ label: $event })" />
          </el-form-item>
          <el-form-item class="form-item-compact" label="字段标识（修改后联动立即重算）">
            <el-input
              v-model="nameDraft"
              :class="{ 'name-input-error': nameError }"
              placeholder="字母/下划线开头，如 applicantName"
              @keyup.enter="commitName"
              @blur="commitName"
            />
            <div v-if="nameError" class="error-text">{{ nameError }}</div>
            <div v-else class="muted" style="margin-top: 4px">标识是联动与答案迁移的唯一键，需全表单唯一</div>
          </el-form-item>
          <el-form-item v-if="node.type === 'input' || node.type === 'select' || node.type === 'date'" class="form-item-compact" label="占位提示">
            <el-input :model-value="node.placeholder" @update:model-value="patch({ placeholder: $event })" />
          </el-form-item>
        </el-form>
      </section>

      <section v-if="node.type === 'select'" class="property-group">
        <h4>选择项</h4>
        <el-input v-model="optionText" type="textarea" :rows="5" placeholder="每行一个选项" @change="optionsChanged" />
      </section>

      <section v-if="node.type === 'table'" class="property-group">
        <h4>表格列</h4>
        <el-input v-model="columnText" type="textarea" :rows="5" placeholder="字段key:列标题" @change="columnsChanged" />
        <div class="muted" style="margin-top: 6px">每行格式：key:显示名称</div>
      </section>

      <section v-if="node.type !== 'group' && node.type !== 'container' && node.type !== 'table'" class="property-group">
        <h4>校验规则（发布时冻结）</h4>
        <el-checkbox
          :model-value="node.validation?.required"
          @update:model-value="patchValidation('required', $event)"
        >
          必填
        </el-checkbox>
        <el-form label-position="top" size="small" style="margin-top: 10px">
          <el-form-item class="form-item-compact" label="最小长度">
            <el-input-number
              :model-value="node.validation?.minLength"
              :min="0"
              controls-position="right"
              @update:model-value="patchValidation('minLength', $event)"
            />
          </el-form-item>
          <el-form-item class="form-item-compact" label="最大长度">
            <el-input-number
              :model-value="node.validation?.maxLength"
              :min="0"
              controls-position="right"
              @update:model-value="patchValidation('maxLength', $event)"
            />
          </el-form-item>
          <el-form-item class="form-item-compact" label="正则表达式">
            <el-input :model-value="node.validation?.pattern" placeholder="例：^\\d+$" @update:model-value="patchValidation('pattern', $event)" />
          </el-form-item>
          <el-form-item class="form-item-compact" label="错误提示">
            <el-input :model-value="node.validation?.message" @update:model-value="patchValidation('message', $event)" />
          </el-form-item>
        </el-form>
      </section>

      <section class="property-group">
        <h4>联动条件（按字段路径引用）</h4>
        <el-alert
          v-if="conditionBroken"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 10px"
          title="目标字段标识已变更或被删除，当前条件已失效"
          description="重新选择条件字段后恢复联动。"
        />
        <el-form label-position="top" size="small">
          <el-form-item class="form-item-compact" label="当字段">
            <el-select
              :model-value="node.condition?.fieldPath"
              clearable
              style="width: 100%"
              placeholder="选择触发字段"
              @change="setConditionField"
            >
              <el-option v-for="field in store.flatFields" :key="field.path" :label="`${field.node.label}（${field.path}）`" :value="field.path" />
            </el-select>
          </el-form-item>
          <template v-if="node.condition?.fieldPath">
            <el-form-item class="form-item-compact" label="判断方式">
              <el-select :model-value="node.condition.operator" style="width: 100%" @change="store.updateCondition({ operator: $event as VisibilityCondition['operator'] })">
                <el-option label="等于" value="equals" />
                <el-option label="不等于" value="notEquals" />
                <el-option label="包含" value="contains" />
                <el-option label="大于" value="greaterThan" />
                <el-option label="小于" value="lessThan" />
              </el-select>
            </el-form-item>
            <el-form-item class="form-item-compact" label="比较值">
              <el-input :model-value="node.condition.value" @update:model-value="store.updateCondition({ value: $event })" />
            </el-form-item>
            <el-button size="small" @click="clearCondition">清除条件</el-button>
          </template>
        </el-form>
      </section>

      <section class="property-group">
        <h4>节点操作</h4>
        <div class="toolbar-row">
          <el-button size="small" @click="store.duplicateSelected">复制节点</el-button>
          <el-button size="small" type="danger" plain @click="store.removeSelected">删除节点</el-button>
        </div>
      </section>
    </div>
    <div v-else class="panel-scroll muted">点击画布中的节点以配置属性</div>
  </aside>
</template>
