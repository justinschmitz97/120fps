<script>
// A genuinely propless Options-API component: no props/extends/mixins key.
// The same legitimate case as a leaf React component with an empty props
// type -- must not be flagged as excluded.
export default {
  name: "OptionsPropless",
};
</script>

<template>
  <div class="options-propless">static</div>
</template>
