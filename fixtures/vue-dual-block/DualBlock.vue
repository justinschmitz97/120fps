<script lang="ts">
export interface DualBlockProps {
  label?: string;
  color?: "primary" | "secondary" | "error";
  square?: boolean;
  count?: number;
}
</script>

<script setup lang="ts">
const props = defineProps<DualBlockProps>();
</script>

<template>
  <span :class="['badge', color, { square }]">{{ label }}{{ count }}</span>
</template>
