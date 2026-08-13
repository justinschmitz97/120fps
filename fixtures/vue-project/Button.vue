<script setup lang="ts">
interface Props {
  label: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  count?: number;
}

const props = defineProps<Props>();
</script>

<template>
  <button class="btn" :class="props.variant" :disabled="props.disabled">
    {{ props.label }}<span v-if="props.count"> ({{ props.count }})</span>
  </button>
</template>

<style scoped>
.btn {
  padding: 4px 8px;
}
</style>
