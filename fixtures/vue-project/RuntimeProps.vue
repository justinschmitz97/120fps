<script setup>
// The runtime object form carries no types (ADR 0002): it mounts, it extracts
// no schemas.
const props = defineProps({ label: String });
</script>

<template>
  <span class="runtime">{{ props.label }}</span>
</template>
