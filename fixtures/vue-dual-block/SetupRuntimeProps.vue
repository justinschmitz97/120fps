<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  name: "SetupRuntimeProps",
  props: {
    label: { type: String, default: "hi" },
    size: { type: String, default: "small" },
  },
  setup(props) {
    return () => props.label;
  },
});
</script>
