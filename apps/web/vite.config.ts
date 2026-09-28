import { fileURLToPath } from "node:url"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  server: { port: 3000 },
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // AI Search / Vectorize などはリモートにしか無い。EXPLORER_MODE=local の開発ではアカウント無しで動かす
      remoteBindings: process.env.CF_REMOTE_BINDINGS === "true",
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
