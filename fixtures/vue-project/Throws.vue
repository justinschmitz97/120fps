<script setup lang="ts">
defineProps<{ mode: string }>();

throw new Error("vue fixture blew up during setup");
</script>

<template>
  <div>unreachable</div>
</template>
