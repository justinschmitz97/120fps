<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <div><h1>{{ title }}</h1><Greeting /></div>
</template>
