import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src")
    }
  },
  // The app tsconfig keeps `jsx: "preserve"` for Next; the test runner compiles JSX itself.
  esbuild: { jsx: "automatic" },
  test: {
    // The browser is this package's only runtime, so its tests run in one. The pure
    // modules under test do not depend on the DOM, but the components do, and a single
    // environment keeps the suite from having to declare which is which.
    environment: "jsdom",
    // A real origin, so storage and cookies exist and a test can assert they stay empty.
    environmentOptions: { jsdom: { url: "http://localhost:3000" } },
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"]
  }
});
