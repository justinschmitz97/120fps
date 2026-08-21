<script setup lang="ts">
defineProps<{ value?: string | number; width?: number | string }>();
</script>

<template>
  <span class="badge">{{ value }}{{ width }}</span>
</template>
