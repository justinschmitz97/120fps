<script setup lang="ts">
defineProps<{ title: string; dense?: boolean }>();
</script>

<template>
  <section class="widget" :data-dense="dense">
    <h3>{{ title }}</h3>
  </section>
</template>
