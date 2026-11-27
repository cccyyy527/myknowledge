<script setup>
// 深度思考开关：只影响当前这个面板的请求，不写回设置
const props = defineProps({
  modelValue: Boolean,
  hint: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <label class="ai-think" :title="hint || '让模型先想一段再答，复杂整合更准，但慢一些、也更费 token'">
    <input
      type="checkbox"
      :checked="modelValue"
      @change="emit('update:modelValue', $event.target.checked)"
    />
    <span>深度思考</span>
  </label>
</template>
