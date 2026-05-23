import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import type { Server as HttpServer } from "node:http"
import path from "node:path"
import { defineConfig } from "vite"
import { installChatSocketServer } from "./app/server/socket.server"

export default defineConfig({
  plugins: [
    {
      name: "xedoc-socket",
      configureServer(server) {
        if (server.httpServer) {
          installChatSocketServer(server.httpServer as unknown as HttpServer)
        }
      },
    },
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
    },
  },
  optimizeDeps: {
    exclude: ["ghostty-web"],
  },
})
