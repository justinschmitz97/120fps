<script setup lang="ts">
import Button from "./Button.vue";
import Card from "./Card.vue";
</script>

<template>
  <div class="scene">
    <Button label="save" variant="primary" />
    <Card heading="Recent" :items="[{ id: 1, title: 'one' }, { id: 2, title: 'two' }]" />
  </div>
</template>
