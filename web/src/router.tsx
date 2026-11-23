import { useEffect, useState } from "preact/hooks";

/** A tiny History-API router: the app has a handful of routes and no nested layouts. */
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

/** "/history/:id" against "/history/12" → { id: "12" }, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const a = path.replace(/\/+$/, "").split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export function Link(props: { href: string; class?: string; current?: boolean; children: preact.ComponentChildren }) {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-current={props.current ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
