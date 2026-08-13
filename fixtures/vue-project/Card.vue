<script setup lang="ts">
import type { CardProps } from "./types";

const props = withDefaults(defineProps<CardProps>(), {
  compact: false,
  tone: "warning",
});
</script>

<template>
  <section class="card" :data-tone="props.tone">
    <h2>{{ props.heading }}</h2>
    <ul>
      <li v-for="item in props.items" :key="item.id">{{ item.title }}</li>
    </ul>
  </section>
</template>
