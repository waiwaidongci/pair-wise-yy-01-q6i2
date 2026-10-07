<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import FormRenderer from '../components/FormRenderer.vue'
import { useDesignerStore } from '../stores/designer'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import { evaluateCondition, validateValue, walkWithPaths } from '../utils/schema'

const store = useDesignerStore()
const values = reactive<RuntimeValueMap>({})
const errors = reactive<Record<string, string>>({})
const submitted = ref(false)

function applyDefaults(nodes: FieldNode[]) {
  walkWithPaths(nodes).forEach(({ node, path }) => {
    if (node.type === 'table') values[path] = []
    else if (node.defaultValue !== undefined) values[path] = node.defaultValue
    else if (node.type === 'select' || node.type === 'date') values[path] = ''
    else if (node.type !== 'group' && node.type !== 'container') values[path] = ''
  })
}
applyDefaults(store.nodes)

// 草稿结构变化时补全新增字段的默认值（已填答案按路径保留）
watch(() => store.nodes, (nodes) => {
  walkWithPaths(nodes).forEach(({ node, path }) => {
    if (values[path] !== undefined) return
    if (node.type === 'table') values[path] = []
    else if (node.defaultValue !== undefined) values[path] = node.defaultValue
    else if (node.type === 'select' || node.type === 'date') values[path] = ''
    else if (node.type !== 'group' && node.type !== 'container') values[path] = ''
  })
}, { deep: true })

const visibleCount = computed(() => {
  const walk = (nodes: FieldNode[]): number => nodes.reduce((count, node) => {
    if (!evaluateCondition(node.condition, values, nodes)) return count
    return count + 1 + walk(node.children ?? [])
  }, 0)
  return walk(store.nodes)
})

function updateValue(path: string, value: unknown) {
  values[path] = value
}

function updateError(path: string, error: string) {
  if (error) errors[path] = error
  else delete errors[path]
}

function validateAll(nodes: FieldNode[]) {
  let valid = true
  nodes.forEach((node) => {
    if (!evaluateCondition(node.condition, values, nodes)) return
    if (node.type !== 'group' && node.type !== 'container') {
      const path = walkWithPaths([node])[0]?.path ?? node.name
      const error = validateValue(values[path], node.validation)
      if (error) {
        errors[path] = error
        valid = false
      }
    }
    if (!validateAll(node.children ?? [])) valid = false
  })
  return valid
}

function submit() {
  Object.keys(errors).forEach((key) => delete errors[key])
  submitted.value = true
  if (!validateAll(store.nodes)) {
    ElMessage.error('表单校验未通过，请检查红色提示')
    return
  }
  ElMessage.success('预览提交成功，数据已生成')
}
</script>

<template>
  <div class="preview-wrap">
    <div class="preview-card">
      <h1>{{ store.title }}</h1>
      <p>{{ store.description }}</p>
      <el-alert
        v-for="broken in store.brokenConditions"
        :key="broken.node.id"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        :title="`字段「${broken.node.label}」的联动条件已失效：引用字段被删除或改名，预览已按始终显示重算`"
      />
      <FormRenderer
        :nodes="store.nodes"
        :values="values"
        :errors="errors"
        @update="updateValue"
        @error="updateError"
      />
      <el-button type="primary" size="large" @click="submit">提交表单预览</el-button>
      <div class="summary-box">
        当前可见字段：{{ visibleCount }} 个；校验错误：{{ Object.keys(errors).length }} 个；失效联动：{{ store.brokenConditions.length }} 条。
        <span v-if="submitted">最近一次提交已触发完整条件显隐与校验流程。</span>
      </div>
    </div>
  </div>
</template>
