<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <p data-testid="text">{{ text }}</p>
</template>
