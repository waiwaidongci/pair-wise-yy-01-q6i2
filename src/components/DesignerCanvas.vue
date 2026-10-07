<script setup lang="ts">
import { ref } from 'vue'
import { useDropZone } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Promotion, RefreshLeft, RefreshRight, Upload } from '@element-plus/icons-vue'
import { useDesignerStore } from '../stores/designer'
import { useReleaseStore } from '../stores/release'
import type { FieldNode } from '../types/form'
import BuilderNode from './BuilderNode.vue'

const emit = defineEmits<{ importJson: [] }>()
const store = useDesignerStore()
const releaseStore = useReleaseStore()
const canvasRef = ref<HTMLElement | null>(null)
const publishing = ref(false)

useDropZone(canvasRef, {
  dataTypes: ['application/x-form-field'],
  onDrop: (_files, event) => {
    const dragEvent = event as DragEvent
    const type = dragEvent.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
    if (type) store.addField(type)
  },
})

function handleDrop(event: DragEvent) {
  event.preventDefault()
  const sourceId = event.dataTransfer?.getData('application/x-form-node')
  if (sourceId) {
    store.moveNodeTo(sourceId, undefined, store.nodes.length)
    return
  }
  const type = event.dataTransfer?.getData('application/x-form-field') as FieldNode['type']
  if (type) store.addField(type)
}

async function publish() {
  if (!store.draftDirty) {
    ElMessage.info('草稿与已发布版本一致，没有待发布内容')
    return
  }
  try {
    await ElMessageBox.confirm(
      '发布将冻结当前草稿的字段结构、校验规则与联动条件。已开始的填单会话仍按其开始时版本运行，之后可手动迁移到新版本。',
      '确认发布新版本',
      { confirmButtonText: '冻结并发布', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  publishing.value = true
  try {
    const revision = store.publish()
    ElMessage.success(`已发布 v${revision.rev}，后续修改只保留在新草稿中`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发布失败，草稿未受影响')
  } finally {
    publishing.value = false
  }
}
</script>

<template>
  <section class="canvas-panel">
    <div class="canvas-toolbar">
      <div class="toolbar-row">
        <el-button-group>
          <el-button :disabled="!store.canUndo" @click="store.undo">
            <el-icon><RefreshLeft /></el-icon>
            撤销
          </el-button>
          <el-button :disabled="!store.canRedo" @click="store.redo">
            <el-icon><RefreshRight /></el-icon>
            重做
          </el-button>
        </el-button-group>
        <el-divider direction="vertical" />
        <el-tag v-if="releaseStore.latestRevision" size="small" type="success" effect="plain">
          已发布 v{{ releaseStore.latestRevision.rev }}
        </el-tag>
        <el-tag v-else size="small" type="info" effect="plain">尚未发布</el-tag>
        <el-tag v-if="store.draftDirty" size="small" type="warning" effect="light">草稿有未发布修改</el-tag>
        <el-button type="primary" :loading="publishing" @click="publish">
          <el-icon><Promotion /></el-icon>
          发布版本
        </el-button>
      </div>
      <el-button type="primary" plain @click="emit('importJson')">
        <el-icon><Upload /></el-icon>
        导入 JSON
      </el-button>
    </div>
    <div class="canvas-scroll">
      <div
        ref="canvasRef"
        class="form-canvas"
        @dragover.prevent
        @drop="handleDrop"
      >
        <el-input
          :model-value="store.title"
          class="form-title-input"
          @update:model-value="store.setTitle($event)"
        />
        <el-input
          :model-value="store.description"
          type="textarea"
          :rows="2"
          resize="none"
          style="margin-bottom: 20px"
          @update:model-value="store.setDescription($event)"
        />
        <BuilderNode
          v-for="(node, index) in store.nodes"
          :key="node.id"
          :node="node"
          :index="index"
        />
        <div v-if="!store.nodes.length" class="empty-canvas">
          <strong>画布还是空的</strong>
          从左侧组件库拖入第一个业务字段
        </div>
      </div>
    </div>
  </section>
</template>
