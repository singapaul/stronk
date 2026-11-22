import { useEffect, useState } from "preact/hooks";
import { useRegisterSW } from "virtual:pwa-register/preact";
import { api, OUTBOX_EVENT, outbox, UNAUTHORIZED_EVENT } from "./api.ts";
import { Link, match, navigate, usePath } from "./router.tsx";
import { ActiveWorkout } from "./pages/ActiveWorkout.tsx";
import { Body } from "./pages/Body.tsx";
import { ExercisePage } from "./pages/ExercisePage.tsx";
import { History } from "./pages/History.tsx";
import { HistoryDetail } from "./pages/HistoryDetail.tsx";
import { Login } from "./pages/Login.tsx";
import { WorkoutTab } from "./pages/WorkoutTab.tsx";

type Me = { email: string } | { signedOut: true; google: string; dev_login: string } | null;

export function App() {
  const [me, setMe] = useState<Me>(null);
  const path = usePath();
  const [pending, setPending] = useState(outbox.list().length);
  const [online, setOnline] = useState(navigator.onLine);
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  const checkSession = () =>
    fetch("/auth/me", { credentials: "same-origin" })
      .then(async (r) => setMe(r.ok ? await r.json() : { signedOut: true, ...(await r.json()) }))
      .catch(() => setMe((m) => m ?? { signedOut: true, google: "unknown", dev_login: "unknown" }));

  useEffect(() => {
    void checkSession();
    const onUnauthorized = () => void checkSession();
    const onOutbox = () => setPending(outbox.list().length);
    const onNet = () => setOnline(navigator.onLine);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener(OUTBOX_EVENT, onOutbox);
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener(OUTBOX_EVENT, onOutbox);
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", onNet);
    };
  }, []);

  if (me === null) return <div class="splash">stronk</div>;
  if ("signedOut" in me) return <Login google={me.google} devLogin={me.dev_login} />;

  const signOut = async () => {
    await api("POST", "/auth/logout");
    void checkSession();
    navigate("/", true);
  };

  let page: preact.ComponentChildren;
  let params: Record<string, string> | null;
  if ((params = match("/w/:id", path))) page = <ActiveWorkout id={Number(params.id)} />;
  else if (path === "/history") page = <History />;
  else if ((params = match("/history/:id", path))) page = <HistoryDetail id={Number(params.id)} />;
  else if ((params = match("/exercise/:id", path))) page = <ExercisePage id={params.id!} />;
  else if (path === "/body") page = <Body email={me.email} onSignOut={signOut} />;
  else page = <WorkoutTab />;

  const tab = path.startsWith("/history") || path.startsWith("/exercise") ? "history" : path === "/body" ? "body" : "workout";

  return (
    <div class="app">
      {(!online || pending > 0) && (
        <div class="banner">
          {online ? "Syncing" : "Offline"}
          {pending > 0 ? ` · ${pending} change${pending === 1 ? "" : "s"} waiting to sync` : " · changes will sync when you're back online"}
        </div>
      )}
      {needRefresh && (
        <div class="banner update">
          A new version is ready. <button onClick={() => updateServiceWorker(true)}>Reload</button>
        </div>
      )}
      <main>{page}</main>
      <nav class="tabs">
        <Link href="/" class={tab === "workout" ? "active" : ""}>
          <span class="tab-icon">●</span>Workout
        </Link>
        <Link href="/history" class={tab === "history" ? "active" : ""}>
          <span class="tab-icon">≡</span>History
        </Link>
        <Link href="/body" class={tab === "body" ? "active" : ""}>
          <span class="tab-icon">◐</span>Body
        </Link>
      </nav>
    </div>
  );
}
