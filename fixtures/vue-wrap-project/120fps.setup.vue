<script lang="ts">
export const viewport = { width: 500, height: 400 };

export function setup(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      (window as any).__vueWrapSeeded = true;
      resolve();
    }, 10);
  });
}

export function teardown(): void {
  delete (window as any).__vueWrapSeeded;
}
</script>

<script setup lang="ts">
defineOptions({ name: "Fps120Wrapper" });
</script>

<template>
  <div data-wrap="vue-provider">
    <slot />
  </div>
</template>
