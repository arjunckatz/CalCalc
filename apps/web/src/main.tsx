import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createApiClient } from "./api";
import { createBrowserAuth } from "./auth";
import type { PublicConfig } from "./config";
import { createWebClient } from "./store";
import "./styles.css";

declare const __PUBLIC_CONFIG__: PublicConfig;
const root = createRoot(document.getElementById("root")!);
const client = createWebClient({
  auth: createBrowserAuth(__PUBLIC_CONFIG__),
  api: createApiClient(__PUBLIC_CONFIG__.apiUrl),
  newKey: () => crypto.randomUUID(),
});
root.render(<App client={client} />);
