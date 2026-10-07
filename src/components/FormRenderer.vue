<script setup lang="ts">
import { provide } from 'vue'
import type { FieldNode, RuntimeValueMap } from '../types/form'
import RuntimeField from './RuntimeField.vue'

const props = defineProps<{
  nodes: FieldNode[]
  values: RuntimeValueMap
  errors?: Record<string, string>
}>()

const emit = defineEmits<{
  update: [path: string, value: unknown]
  error: [path: string, error: string]
}>()

provide('formRootNodes', props.nodes)
</script>

<template>
  <RuntimeField
    v-for="node in nodes"
    :key="node.id"
    :node="node"
    :path="node.name"
    :values="values"
    :errors="errors ?? {}"
    @update="(path, value) => emit('update', path, value)"
    @error="(path, error) => emit('error', path, error)"
  />
</template>
