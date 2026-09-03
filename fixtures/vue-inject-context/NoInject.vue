<script setup lang="ts">
interface Props {
  label?: string;
}

defineProps<Props>();
</script>

<template>
  <button>{{ label }}</button>
</template>
