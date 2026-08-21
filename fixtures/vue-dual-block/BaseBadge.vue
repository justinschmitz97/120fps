<script lang="ts">
export default {
  name: "BaseBadge",
  props: {
    value: { type: String, default: "" },
    severity: { type: String, default: "info" },
    size: { type: String, default: "normal" },
  },
};
</script>

<template>
  <span><slot /></span>
</template>
