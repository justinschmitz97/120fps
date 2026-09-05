<script setup lang="ts">
interface Props {
  label?: string;
}

defineProps<Props>();

// const context = inject("dialog-context");
/* inject("also-not-read") */
</script>

<template>
  <button>{{ label }}</button>
</template>
