import { defineConfig, loadEnv } from "vite";
import { readPublicConfig } from "./src/config";

export default defineConfig(({ mode }) => ({
  // Only the three explicitly validated public values enter the browser bundle.
  envPrefix: [],
  define: {
    __PUBLIC_CONFIG__: JSON.stringify(
      readPublicConfig(loadEnv(mode, process.cwd(), "VITE_")),
    ),
  },
}));
