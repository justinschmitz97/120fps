<script>
// PrimeVue's BaseButton.vue shape: props declared as a runtime Options-API
// object literal. ADR 0002 deliberately does not read this form.
export default {
  name: "OptionsProps",
  props: {
    label: { type: String, default: null },
    icon: { type: String, default: null },
  },
};
</script>

<template>
  <button class="options-props">{{ label }}</button>
</template>
