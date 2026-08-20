<script>
// PrimeVue's Button.vue/DataTable.vue shape: no own `props` key, all runtime
// props inherited through `extends: BaseX`. The chain is disclosed, not
// followed: ADR 0002 stays out of scope for reading a runtime props object,
// whether declared directly here or on the extended component.
import OptionsProps from "./OptionsProps.vue";

export default {
  name: "OptionsExtends",
  extends: OptionsProps,
  inheritAttrs: false,
};
</script>

<template>
  <button class="options-extends">{{ label }}</button>
</template>
