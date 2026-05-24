import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { registerSW } from "virtual:pwa-register";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Service worker registration with auto-update + a small "new version available" notice.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // The App listens for this event and shows a banner.
    window.dispatchEvent(new CustomEvent("ledger:update-ready"));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent("ledger:offline-ready"));
  },
});

// Expose for the in-app "Reload to update" button.
window.__ledgerUpdateSW = updateSW;
