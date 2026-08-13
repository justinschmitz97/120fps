<script setup lang="ts">
defineProps<{ tag: string }>();
</script>

<template>
  <em class="child">{{ tag }}</em>
</template>
