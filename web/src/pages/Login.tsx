export function Login({ google, devLogin }: { google: string; devLogin: string }) {
  return (
    <div class="login">
      <div class="logo">stronk</div>
      <p class="muted">Your cycles, targets and lifts.</p>
      {google !== "disabled" && (
        <a class="btn primary big" href="/auth/google">
          Sign in with Google
        </a>
      )}
      {devLogin === "enabled" && (
        <a class="btn big" href="/auth/dev">
          Dev sign-in
        </a>
      )}
      {google === "disabled" && devLogin !== "enabled" && (
        <p class="muted small">Sign-in isn't configured on this server yet. See the README's “Web app” section.</p>
      )}
    </div>
  );
}
