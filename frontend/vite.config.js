import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: {
      "/report": process.env.INFERGATE_BACKEND_URL || "http://127.0.0.1:3000",
      "/manager": process.env.INFERGATE_BACKEND_URL || "http://127.0.0.1:3000",
      "/user": process.env.INFERGATE_BACKEND_URL || "http://127.0.0.1:3000",
      "/admin": process.env.INFERGATE_BACKEND_URL || "http://127.0.0.1:3000",
    },
  },
});
