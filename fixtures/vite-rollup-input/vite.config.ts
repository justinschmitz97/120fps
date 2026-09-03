import { resolve } from "node:path";

export default {
  build: {
    rollupOptions: {
      input: resolve("pages/app.html"),
    },
  },
};
