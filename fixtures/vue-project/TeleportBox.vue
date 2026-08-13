<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <div class="host">
    <Teleport to="body">
      <div class="teleported"><button type="button">{{ label }}</button></div>
    </Teleport>
  </div>
</template>
