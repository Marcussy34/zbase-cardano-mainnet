import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import overview from "../../../docs/PRD.md?raw";
import specification from "../../../docs/SPEC.md?raw";
import plan from "../../../docs/PLAN-M0.md?raw";

const topics = {
  overview: { label: "Overview", source: overview },
  spec: { label: "Specification", source: specification },
  plan: { label: "Build plan", source: plan },
};

type Topic = keyof typeof topics;

function currentTopic(): Topic {
  const topic = new URLSearchParams(window.location.search).get("topic");
  return topic === "spec" || topic === "plan" ? topic : "overview";
}

function documentLink(href: string): string {
  if (!href || href.startsWith("#") || /^(?:[a-z]+:|\/\/)/i.test(href))
    return href;
  const [path, hash] = href.split("#");
  const topic = (
    { "PRD.md": "overview", "SPEC.md": "spec", "PLAN-M0.md": "plan" } as Record<
      string,
      string
    >
  )[path.replace(/^\.\//, "")];
  const fragment = hash ? `#${hash}` : "";
  if (topic) return `/docs/?topic=${topic}${fragment}`;
  const relativePath = new URL(path, "https://repo.invalid/docs/").pathname;
  return `https://github.com/Marcussy34/zx402/blob/main${relativePath}${fragment}`;
}

function headingText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? headingText(child.props.children)
        : "";
    })
    .join("");
}

function Heading({
  level,
  children,
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children?: ReactNode;
}) {
  const Tag = `h${level}` as const;
  const id = headingText(children)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return <Tag id={id}>{children}</Tag>;
}

export default function Docs() {
  const [topic, setTopic] = useState<Topic>(currentTopic);
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    const onHistoryChange = () => setTopic(currentTopic());
    window.addEventListener("popstate", onHistoryChange);
    return () => window.removeEventListener("popstate", onHistoryChange);
  }, []);

  useEffect(() => {
    document.title = `${topics[topic].label} | zx402 docs`;
    if (window.location.hash) {
      let fragment: string;
      try {
        fragment = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      const section = document.getElementById(fragment);
      section?.scrollIntoView?.({ block: "start" });
    }
  }, [topic]);

  function selectTopic(nextTopic: Topic, hash = "") {
    const nextPath = `/docs/?topic=${nextTopic}${hash}`;
    if (
      `${window.location.pathname}${window.location.search}${window.location.hash}` !==
      nextPath
    ) {
      window.history.pushState({}, "", nextPath);
    }
    setTopic(nextTopic);
    if (!hash) article.current?.scrollIntoView?.({ block: "start" });
  }

  return (
    <div className="docs-shell">
      <header className="docs-header">
        <a href="/" aria-label="Back to zx402">
          ← Back to zx402
        </a>
        <span>Cardano documentation</span>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <p className="docs-eyebrow">The blueprint</p>
          <nav aria-label="Documentation topics">
            {(Object.keys(topics) as Topic[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`docs-topic${key === topic ? " docs-topic-active" : ""}`}
                aria-pressed={key === topic}
                aria-controls="docs-content"
                onClick={() => selectTopic(key)}
              >
                {topics[key].label}
              </button>
            ))}
          </nav>
          <p>
            Live on the Preprod test network. These are the deep documents; the
            guide is at{" "}
            <a href="https://docs.zx402.org/">the documentation site</a>.
          </p>
        </aside>
        <main>
          <article
            id="docs-content"
            className="docs-article"
            ref={article}
            aria-label={topics[topic].label}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <Heading level={1}>{children}</Heading>,
                h2: ({ children }) => <Heading level={2}>{children}</Heading>,
                h3: ({ children }) => <Heading level={3}>{children}</Heading>,
                h4: ({ children }) => <Heading level={4}>{children}</Heading>,
                h5: ({ children }) => <Heading level={5}>{children}</Heading>,
                h6: ({ children }) => <Heading level={6}>{children}</Heading>,
                a: ({ href = "", children }) => {
                  const target = documentLink(href);
                  return (
                    <a
                      href={target}
                      onClick={(event) => {
                        if (
                          !target.startsWith("/docs/?topic=") ||
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        const url = new URL(target, window.location.origin);
                        selectTopic(
                          url.searchParams.get("topic") as Topic,
                          url.hash,
                        );
                      }}
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {topics[topic].source}
            </ReactMarkdown>
          </article>
        </main>
      </div>
    </div>
  );
}
