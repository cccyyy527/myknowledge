<script setup>
import { ref, watch, onUnmounted } from 'vue'

// 非流式请求（整合、一致性检查、整篇改写）没有逐字输出，只能给个计时器证明它还活着；
// 勾了深度思考后这类请求要跑几十秒，没反馈很容易被当成卡死。
const props = defineProps({
  active: Boolean,
  label: { type: String, default: '处理中' },
})

const secs = ref(0)
let timer = 0
watch(
  () => props.active,
  (v) => {
    clearInterval(timer)
    secs.value = 0
    if (!v) return
    timer = setInterval(() => secs.value++, 1000)
  },
  { immediate: true },
)
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <span v-if="active" class="ai-spin">
    <span class="ai-spin-dot"></span>{{ label }} {{ secs }}s<span v-if="secs >= 25" class="ai-spin-tip"
      >深度思考会慢些，别急着关</span
    >
  </span>
</template>
