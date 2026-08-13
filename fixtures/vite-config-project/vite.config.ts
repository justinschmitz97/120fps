// Stands in for a project whose vite.config registers plugins built for a
// different Vite major: every transform fails if the harness loads this file.
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "hostile-transform",
      transform() {
        throw new Error("project vite.config plugin ran inside the harness");
      },
    },
  ],
  server: { open: true },
});
