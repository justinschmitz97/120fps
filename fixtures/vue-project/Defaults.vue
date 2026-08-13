<script setup lang="ts">
interface Props {
  rows?: string[];
  meta?: { kind: string };
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  rows: () => ["alpha", "beta"],
  meta: () => ({ kind: "note" }),
  title: "untitled",
});
</script>

<template>
  <section :data-kind="props.meta.kind">
    <h4>{{ props.title }}</h4>
    <p v-for="row in props.rows" :key="row">{{ row }}</p>
  </section>
</template>
