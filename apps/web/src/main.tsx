import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "./styles.css";
import "./motion.css";
import "./hero-headline.css";
import "./footer.css";
import App from "./App";

const Docs = lazy(() => import("./Docs"));
const root = createRoot(document.getElementById("root")!);
import.meta.hot?.dispose(() => root.unmount());
root.render(
  <StrictMode>
    {window.location.pathname.startsWith("/docs") ? (
      <Suspense
        fallback={<p className="docs-loading">Opening documentation…</p>}
      >
        <Docs />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
