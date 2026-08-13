<script setup lang="ts">
import "server-only";

defineProps<{ title: string }>();
</script>

<template>
  <h1>{{ title }}</h1>
</template>
