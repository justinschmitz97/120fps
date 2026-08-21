<script lang="ts">
import type { MissingProps } from "#build/nowhere/missing";
export type { MissingProps };
</script>

<script setup lang="ts">
const props = defineProps<MissingProps>();
</script>

<template>
  <span class="badge">{{ props }}</span>
</template>
