import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// bitcoinjs-lib and near-api-js still reach for Buffer in a few code paths.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
