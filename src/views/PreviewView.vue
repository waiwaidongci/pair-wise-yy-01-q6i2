<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import RuntimeField from '../components/RuntimeField.vue'
import { useDesignerStore } from '../stores/designer'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { buildDefaultValues, collectFields, evaluateCondition, flattenNodes, validateValue } from '../utils/schema'

const store = useDesignerStore()
const values = reactive<RuntimeValueMap>({})
const errors = reactive<Record<string, string>>({})
const submitted = ref(false)

function applyDefaults(nodes: FieldNode[]) {
  Object.assign(values, buildDefaultValues(nodes))
}
applyDefaults(store.nodes)

// 草稿字段标识/结构变化即时重算：新字段补默认值，旧路径残留保留但不再参与渲染
watch(() => store.nodes, (nodes) => {
  const defaults = buildDefaultValues(nodes)
  Object.keys(defaults).forEach((path) => {
    if (values[path] === undefined) values[path] = defaults[path]
  })
}, { deep: true })

const validPaths = computed(() => new Set(collectFields(store.nodes).map(({ path }) => path)))
const pathById = computed(() => {
  const map = new Map<string, string>()
  collectFields(store.nodes).forEach(({ node, path }) => map.set(node.id, path))
  return map
})

const visibleCount = computed(() => {
  const walk = (items: FieldNode[]): number => items.reduce((count, node) => {
    if (!evaluateCondition(node.condition, values, validPaths.value).visible) return count
    return count + 1 + walk(node.children ?? [])
  }, 0)
  return walk(store.nodes)
})

/** 字段标识一改，引用旧路径的联动条件立即失效并在此集中提示 */
const brokenConditions = computed(() => flattenNodes(store.nodes)
  .filter((node) => node.condition && !validPaths.value.has(node.condition.fieldPath))
  .map((node) => ({ label: node.label, target: node.condition!.fieldPath })))

function updateValue(path: string, value: unknown) {
  values[path] = value
}

function updateError(path: string, error: string) {
  if (error) errors[path] = error
  else delete errors[path]
}

function validateAll(items: FieldNode[]) {
  let valid = true
  items.forEach((node) => {
    if (!evaluateCondition(node.condition, values, validPaths.value).visible) return
    if (node.type !== 'group' && node.type !== 'container') {
      const path = pathById.value.get(node.id)
      if (path) {
        const error = validateValue(values[path], node.validation)
        if (error) {
          errors[path] = error
          valid = false
        } else {
          delete errors[path]
        }
      }
    }
    if (!validateAll(node.children ?? [])) valid = false
  })
  return valid
}

function submit() {
  Object.keys(errors).forEach((key) => delete errors[key])
  submitted.value = true
  if (brokenConditions.value.length) {
    ElMessage.error('存在失效的联动条件，请先在属性面板重新选择条件字段')
    return
  }
  if (!validateAll(store.nodes)) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  ElMessage.success('草稿预览校验通过（预览不生成正式提交）')
}
</script>

<template>
  <div class="preview-wrap">
    <div class="preview-card">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
        title="草稿实时预览：展示当前设计稿，尚未发布的结构、校验与联动改动会即时生效"
      />
      <el-alert
        v-for="item in brokenConditions"
        :key="item.label"
        type="error"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
        :title="`字段「${item.label}」的联动目标 ${item.target} 已不存在，条件失效并已重算（字段隐藏）`"
        description="字段标识被修改或删除会立即解除相关联动，在右侧属性面板重新选择条件字段即可恢复。"
      />
      <h1>{{ store.title }}</h1>
      <p>{{ store.description }}</p>
      <RuntimeField
        v-for="node in store.nodes"
        :key="node.id"
        :node="node"
        :values="values"
        :errors="errors"
        :valid-paths="validPaths"
        @update="updateValue"
        @error="updateError"
      />
      <el-button type="primary" size="large" @click="submit">校验草稿</el-button>
      <div class="summary-box">
        当前可见字段：{{ visibleCount }} 个；失效联动：{{ brokenConditions.length }} 条；校验错误：{{ Object.keys(errors).length }} 个。
        <span v-if="submitted">最近一次校验已按草稿的条件显隐与规则执行。</span>
      </div>
    </div>
  </div>
</template>
