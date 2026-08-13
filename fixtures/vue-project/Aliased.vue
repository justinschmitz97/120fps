<script setup lang="ts">
import type { CardProps } from "@/types";

defineProps<CardProps>();
</script>

<template>
  <div class="aliased">{{ heading }}</div>
</template>
