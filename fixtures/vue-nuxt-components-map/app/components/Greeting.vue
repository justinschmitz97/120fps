<script setup lang="ts">
defineProps<{ name?: string }>()
</script>

<template>
  <p data-testid="greeting">Hello {{ name ?? 'world' }}</p>
</template>
