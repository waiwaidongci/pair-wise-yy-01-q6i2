<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Promotion } from '@element-plus/icons-vue'
import ComponentPalette from '../components/ComponentPalette.vue'
import DesignerCanvas from '../components/DesignerCanvas.vue'
import PropertyPanel from '../components/PropertyPanel.vue'
import { useDesignerStore } from '../stores/designer'
import { useRuntimeStore } from '../stores/runtime'
import type { FormSchema } from '../types/form'

const store = useDesignerStore()
const runtime = useRuntimeStore()
const importVisible = ref(false)
const importText = ref('')
const publishVisible = ref(false)
const publishNote = ref('')

function exportJson() {
  const content = JSON.stringify(store.schema, null, 2)
  navigator.clipboard?.writeText(content)
  ElMessage.success('Schema JSON 已复制到剪贴板')
}

async function showExport() {
  const content = JSON.stringify(store.schema, null, 2)
  await ElMessageBox.alert(`<pre style="max-height:360px;overflow:auto;white-space:pre-wrap">${content.replace(/</g, '&lt;')}</pre>`, 'Schema JSON', {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '关闭',
  })
}

function applyImport() {
  try {
    const parsed = JSON.parse(importText.value) as FormSchema
    if (!parsed.title || !Array.isArray(parsed.nodes)) throw new Error('Schema 缺少 title 或 nodes')
    store.replaceSchema(parsed)
    importVisible.value = false
    importText.value = ''
    ElMessage.success('Schema 导入成功')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'JSON 格式错误')
  }
}

function publish() {
  const version = store.publishCurrent(publishNote.value.trim())
  publishNote.value = ''
  publishVisible.value = false
  ElMessage.success(`已发布 v${version.number}，字段结构、校验与联动条件已冻结`)
}
</script>

<template>
  <div class="designer-grid">
    <ComponentPalette />
    <DesignerCanvas @import-json="importVisible = true" />
    <PropertyPanel />
  </div>

  <div style="position: fixed; right: 320px; bottom: 16px; z-index: 10; display: flex; gap: 8px">
    <el-button type="success" @click="publishVisible = true">
      <el-icon><Promotion /></el-icon>
      发布版本
    </el-button>
    <el-button type="primary" @click="showExport">
      <el-icon><Download /></el-icon>
      查看 / 导出 Schema
    </el-button>
    <el-button @click="exportJson">复制 JSON</el-button>
  </div>

  <el-dialog v-model="importVisible" title="导入表单 Schema" width="680px">
    <el-input
      v-model="importText"
      class="code-modal"
      type="textarea"
      :rows="18"
      placeholder="粘贴由本设计器导出的 JSON"
    />
    <template #footer>
      <el-button @click="importVisible = false">取消</el-button>
      <el-button type="primary" @click="applyImport">校验并导入</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="publishVisible" title="发布版本" width="460px">
    <p class="muted" style="margin: 0 0 12px">
      发布将冻结当前草稿的字段结构、校验与联动条件为不可变快照；发布后继续修改只留在新草稿，不影响已发布版本与会话。
    </p>
    <el-input v-model="publishNote" placeholder="版本说明（可选），如：新增报销字段" maxlength="60" />
    <div v-if="runtime.versions.length" class="muted" style="margin-top: 10px">
      已发布 {{ runtime.versions.length }} 个版本，最新 v{{ runtime.latestVersion?.number }}
    </div>
    <template #footer>
      <el-button @click="publishVisible = false">取消</el-button>
      <el-button type="success" @click="publish">确认发布</el-button>
    </template>
  </el-dialog>
</template>
