import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { fixLeafletIcons } from "./utils/leafletIcons";

// Patch Leaflet's default marker icon path once, before any component ever
// renders a map — see leafletIcons.ts for why this can no longer live inside
// a single page component.
fixLeafletIcons();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
