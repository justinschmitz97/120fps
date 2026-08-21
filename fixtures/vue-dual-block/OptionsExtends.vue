<script lang="ts">
import BaseBadge from "./BaseBadge.vue";

export default {
  name: "OptionsExtends",
  extends: BaseBadge,
};
</script>

<template>
  <span class="badge">{{ value }}</span>
</template>
