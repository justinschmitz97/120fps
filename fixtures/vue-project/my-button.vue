<script setup lang="ts">
defineProps<{ caption: string }>();
</script>

<template>
  <button class="kebab">{{ caption }}</button>
</template>
