<script setup lang="ts">
import { inject } from "vue";

interface Props {
  label?: string;
}

defineProps<Props>();

const context = inject<{ open: boolean }>("dialog-context");
</script>

<template>
  <button>{{ label }}{{ context.open }}</button>
</template>
