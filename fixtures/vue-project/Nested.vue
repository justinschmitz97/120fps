<script setup lang="ts">
import Child from "./Child.vue";
import { LABEL } from "./helpers";

defineProps<{ rows: number }>();
</script>

<template>
  <ul class="nested">
    <li v-for="i in rows" :key="i"><Child :tag="LABEL + i" /></li>
  </ul>
</template>
