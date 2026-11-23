import { COPY } from "../copy.ts";

export function Login({ google, devLogin }: { google: string; devLogin: string }) {
  return (
    <div class="signin enter">
      <span class="mark" aria-label="stronk">
        <span class="mark__ring" aria-hidden="true" />
        stronk
      </span>
      <div class="page-head">
        <h1>{COPY.signIn.title}</h1>
        <p class="lead">{COPY.signIn.lead}</p>
      </div>
      <div class="btn-row">
        {google !== "disabled" && (
          <a class="btn btn--google btn--lg btn--block" href="/auth/google">
            <img src="/icons/google-icon.svg" alt="" width="20" height="20" />
            {COPY.signIn.google}
          </a>
        )}
        {devLogin === "enabled" && (
          <a class="btn btn--secondary btn--lg btn--block" href="/auth/dev">
            {COPY.signIn.dev}
          </a>
        )}
      </div>
      {google === "disabled" && devLogin !== "enabled" && <p class="note">{COPY.signIn.off}</p>}
    </div>
  );
}
