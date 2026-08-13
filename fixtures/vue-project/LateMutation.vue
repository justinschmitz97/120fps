<script setup lang="ts">
import { onMounted, ref } from "vue";

defineProps<{ seed?: string }>();

const rows = ref<number[]>([]);

// Deliberately lands after the mount trace closes: this is the scene M40's
// late-mutation probe has to notice.
onMounted(() => {
  setTimeout(() => {
    rows.value = [1, 2, 3, 4, 5];
  }, 40);
});
</script>

<template>
  <div class="late">
    <span>{{ seed }}</span>
    <ul>
      <li v-for="row in rows" :key="row">row {{ row }}</li>
    </ul>
  </div>
</template>
