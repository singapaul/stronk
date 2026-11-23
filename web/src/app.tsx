import { useEffect, useState } from "preact/hooks";
import { useRegisterSW } from "virtual:pwa-register/preact";
import { api, OUTBOX_EVENT, outbox, UNAUTHORIZED_EVENT } from "./api.ts";
import { Icon } from "./components/Icon.tsx";
import { COPY } from "./copy.ts";
import { ActiveWorkout } from "./pages/ActiveWorkout.tsx";
import { Body } from "./pages/Body.tsx";
import { ExercisePage } from "./pages/ExercisePage.tsx";
import { History } from "./pages/History.tsx";
import { HistoryDetail } from "./pages/HistoryDetail.tsx";
import { Login } from "./pages/Login.tsx";
import { WorkoutTab } from "./pages/WorkoutTab.tsx";
import { Link, match, navigate, usePath } from "./router.tsx";

type Me = { email: string } | { signedOut: true; google: string; dev_login: string } | null;

/** The workout started on this phone, so other tabs can offer to resume it. */
export const ACTIVE_KEY = "stronk.activeWorkout";

export function App() {
  const [me, setMe] = useState<Me>(null);
  const path = usePath();
  const [pending, setPending] = useState(outbox.list().length);
  const [online, setOnline] = useState(navigator.onLine);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

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

  if (me === null) return <div class="signin" aria-busy="true" />;
  if ("signedOut" in me) return <Login google={me.google} devLogin={me.dev_login} />;

  const signOut = async () => {
    await api("POST", "/auth/logout");
    void checkSession();
    navigate("/", true);
  };

  let page: preact.ComponentChildren;
  let params: Record<string, string> | null;
  const inWorkout = !!match("/w/:id", path);
  if ((params = match("/w/:id", path))) page = <ActiveWorkout id={Number(params.id)} />;
  else if (path === "/history") page = <History />;
  else if ((params = match("/history/:id", path))) page = <HistoryDetail id={Number(params.id)} />;
  else if ((params = match("/exercise/:id", path))) page = <ExercisePage id={params.id!} />;
  else if (path === "/body") page = <Body email={me.email} onSignOut={signOut} />;
  else page = <WorkoutTab />;

  const tab = path.startsWith("/history") || path.startsWith("/exercise") ? "history" : path === "/body" ? "body" : "workout";
  const active = localStorage.getItem(ACTIVE_KEY);

  return (
    <div class="app">
      <a class="btn btn--secondary skip-link" href="#main">
        Skip to content
      </a>
      {(!online || pending > 0) && (
        <div class="banner" role="status">
          <Icon name="cloudOff" size={16} />
          {online ? COPY.syncing(pending) : COPY.offline(pending)}
        </div>
      )}
      {needRefresh && (
        <div class="banner" role="status">
          {COPY.update}
          <button class="btn btn--secondary" onClick={() => updateServiceWorker(true)}>
            {COPY.reload}
          </button>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        {page}
      </main>
      {active && !inWorkout && (
        <div class="resume-dock">
          <a
            class="btn btn--primary"
            href={`/w/${active}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/w/${active}`);
            }}
          >
            <Icon name="play" size={16} />
            {COPY.workout.inProgress}
          </a>
        </div>
      )}
      <nav class="tabs" aria-label="Main">
        <Link href="/" class="tab" current={tab === "workout"}>
          <Icon name="dumbbell" />
          {COPY.tabs.workout}
        </Link>
        <Link href="/history" class="tab" current={tab === "history"}>
          <Icon name="history" />
          {COPY.tabs.history}
        </Link>
        <Link href="/body" class="tab" current={tab === "body"}>
          <Icon name="scale" />
          {COPY.tabs.body}
        </Link>
      </nav>
    </div>
  );
}
