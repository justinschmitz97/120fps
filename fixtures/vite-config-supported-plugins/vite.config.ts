// Stands in for a project whose vite.config declares only a plugin the harness
// applies itself (M117 C4): the note about dropped plugins would be false here.
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
});
