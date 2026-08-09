import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const metadata = {
  "/": {
    title: "SystemForge — Build and test distributed systems",
    description:
      "Model a topology, run workloads and failures, and trace bottlenecks in your browser.",
  },
  "/lab": {
    title: "SystemForge Lab",
    description: "Build a topology and run repeatable failure tests.",
  },
  "/custom": {
    title: "Scenario Editor — SystemForge",
    description: "Define workload, incidents, and pass criteria.",
  },
  "/interview": {
    title: "Interview Setup — SystemForge",
    description:
      "Prepare a candidate brief, private rubric, and repeatable scenario.",
  },
  "/replay": {
    title: "Replay a Run — SystemForge",
    description:
      "Verify a replay bundle and recompute the captured run locally.",
  },
} as const;

const setMeta = (selector: string, content: string) => {
  const element = document.head.querySelector<HTMLMetaElement>(selector);
  if (element) element.content = content;
};

export function RouteMetadata() {
  const location = useLocation();

  useEffect(() => {
    const isShared = /^\/scenario\/[A-Za-z0-9-]+$/.test(location.pathname);
    const route =
      metadata[location.pathname as keyof typeof metadata] ??
      (isShared
        ? {
            title: "Shared Scenario — SystemForge",
            description: "Open a shared scenario in the Lab.",
          }
        : {
            title: "Page not found — SystemForge",
            description: "This SystemForge page does not exist.",
          });
    const canonicalUrl = `${window.location.origin}${location.pathname}`;
    document.title = route.title;
    setMeta('meta[name="description"]', route.description);
    setMeta('meta[property="og:title"]', route.title);
    setMeta('meta[property="og:description"]', route.description);
    setMeta('meta[property="og:url"]', canonicalUrl);
    setMeta('meta[name="twitter:title"]', route.title);
    setMeta('meta[name="twitter:description"]', route.description);
    const canonical = document.head.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    if (canonical) canonical.href = canonicalUrl;
    let robots = document.head.querySelector<HTMLMetaElement>(
      'meta[name="robots"]',
    );
    if (!robots) {
      robots = document.createElement("meta");
      robots.name = "robots";
      document.head.append(robots);
    }
    robots.content = isShared
      ? "noindex,follow"
      : metadata[location.pathname as keyof typeof metadata]
        ? "index,follow"
        : "noindex,follow";
  }, [location.pathname]);

  return null;
}
