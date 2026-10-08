import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./apps/web",
  lint: {
    plugins: ["typescript", "react"],
  },
});
