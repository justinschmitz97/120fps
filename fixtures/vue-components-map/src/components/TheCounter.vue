<script setup lang="ts">
const props = defineProps<{ start?: number }>()
</script>

<template>
  <span data-testid="counter">{{ props.start ?? 0 }}</span>
</template>
