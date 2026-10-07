import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "./styles.css";
import "./motion.css";
import "./hero-headline.css";
import "./footer.css";
import App from "./App";

if (window.location.pathname.startsWith("/docs")) {
  window.location.replace("https://docs.zx402.org/");
} else {
  const root = createRoot(document.getElementById("root")!);
  import.meta.hot?.dispose(() => root.unmount());
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
