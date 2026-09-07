<script setup lang="ts">
defineProps<{ text?: string }>()
</script>

<template>
  <p>{{ text ?? 'plain' }}</p>
</template>
