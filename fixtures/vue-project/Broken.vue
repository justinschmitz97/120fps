<script lang="ts">
// A plain <script> with no default export: @vitejs/plugin-vue still imports a
// default from it, so nothing can be mounted.
export const label = "nope";
</script>

<template>
  <div>{{ label }}</div>
</template>
