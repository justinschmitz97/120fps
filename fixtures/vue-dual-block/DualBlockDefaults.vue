<script lang="ts">
export interface DualBlockDefaultsProps {
  label?: string;
  count?: number;
}
</script>

<script setup lang="ts">
const props = withDefaults(defineProps<DualBlockDefaultsProps>(), {
  label: "badge",
  count: 7,
});
</script>

<template>
  <span class="badge">{{ props.label }}{{ props.count }}</span>
</template>
