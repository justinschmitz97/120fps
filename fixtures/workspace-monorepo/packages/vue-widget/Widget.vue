<template>
  <div class="widget">{{ label }}</div>
</template>

<script setup lang="ts">
defineProps<{ label?: string }>();
</script>
