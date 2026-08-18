<script setup lang="ts">
defineProps<{ mode?: string }>();

// Throws from the render function rather than from setup, so Vue's own error
// handling decides whether the failure propagates or only reaches the page.
function boom(): string {
  throw new Error("vue fixture blew up during render");
}
</script>

<template>
  <div>{{ boom() }}</div>
</template>
