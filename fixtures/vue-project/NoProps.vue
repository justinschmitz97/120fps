<script setup lang="ts">
import { ref } from "vue";

const open = ref(false);
</script>

<template>
  <details :open="open"><summary>toggle</summary><p>body</p></details>
</template>
