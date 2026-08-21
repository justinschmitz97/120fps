<script lang="ts">
import type { MissingPresetProps } from "#build/nowhere/missing";
export type { MissingPresetProps };
</script>

<script setup lang="ts">
const props = defineProps<MissingPresetProps>();
</script>

<template>
  <span class="badge">{{ props }}</span>
</template>
