import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  // CSS は既定で空のモジュールになる。lib/theme.ts が ?raw で読むハーネスの既定テーマだけは中身を通す
  test: { include: ["test/**/*.test.ts"], css: { include: [/theme-default\.css/] } },
})
