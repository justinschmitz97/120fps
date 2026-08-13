<script setup lang="ts">
import { ref } from "vue";

interface Props {
  start?: number;
  label?: string;
}

const props = withDefaults(defineProps<Props>(), {
  start: 0,
  label: "increment",
});

const count = ref(props.start);
</script>

<template>
  <div class="counter">
    <span data-testid="count">{{ count }}</span>
    <button type="button" @click="count++">{{ props.label }}</button>
  </div>
</template>
