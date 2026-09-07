<script setup lang="ts">
const { count } = useCounter(0)
</script>

<template>
  <span data-testid="count">{{ count }}</span>
</template>
