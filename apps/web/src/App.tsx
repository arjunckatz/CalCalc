import { useEffect, useState, type FormEvent } from "react";
import { Provider, useSelector } from "react-redux";
import type { WebClient, WebState } from "./store";

export function App({ client }: { client: WebClient }) {
  useEffect(() => client.connect(), [client]);
  return (
    <Provider store={client.store}>
      <ClientView client={client} />
    </Provider>
  );
}

function ClientView({ client }: { client: WebClient }) {
  const auth = useSelector((state: WebState) => state.auth);
  return (
    <main className="shell">
      <header className="masthead">
        <span className="eyebrow">CAL CALC / EXPERIMENTAL CLIENT</span>
        <h1>A day, deliberately.</h1>
        <p>
          Create a logical FoodDay. Your backend keeps the canonical record.
        </p>
      </header>
      {!auth.ready ? (
        <p role="status">Restoring session…</p>
      ) : (
        <>
          {auth.error && (
            <p role="alert" className="error">
              {auth.error}
            </p>
          )}
          {auth.session === null ? (
            <Login client={client} busy={auth.busy} />
          ) : (
            <>
              <div className="session-bar">
                <span>Signed in</span>
                <button
                  className="secondary"
                  disabled={auth.busy}
                  onClick={() => void client.signOut()}
                >
                  {auth.busy ? "Signing out…" : "Sign out"}
                </button>
              </div>
              <FoodDayForm
                key={auth.session.subject}
                client={client}
                authBusy={auth.busy}
              />
            </>
          )}
        </>
      )}
      <footer>
        Experimental adapter · No automatic day selection or closure.
      </footer>
    </main>
  );
}

function Login({ client, busy }: { client: WebClient; busy: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const pending = client.signIn(email, password);
    setPassword("");
    await pending;
  }
  return (
    <section className="card" aria-labelledby="login-heading">
      <h2 id="login-heading">Sign in</h2>
      <p>Use your existing CalCalc account.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        <button disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {busy && <p role="status">Signing in…</p>}
      </form>
    </section>
  );
}

function FoodDayForm({
  client,
  authBusy,
}: {
  client: WebClient;
  authBusy: boolean;
}) {
  const state = useSelector((root: WebState) => root.foodDay);
  const [calorieTarget, setCalories] = useState("");
  const [proteinTarget, setProtein] = useState("");
  const [localDate, setDate] = useState("");
  const [timezone, setTimezone] = useState("");
  const locked =
    authBusy || state.status === "loading" || state.attempt !== null;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    void client.create({
      calorieTarget,
      proteinTarget,
      localDate: localDate || null,
      timezone: timezone || null,
    });
  }
  return (
    <>
      <section className="card" aria-labelledby="create-heading">
        <h2 id="create-heading">Create a FoodDay</h2>
        <p>Targets are exact decimal text. Date and timezone are optional.</p>
        <form onSubmit={submit}>
          <fieldset disabled={locked}>
            <legend className="sr-only">FoodDay targets and context</legend>
            <div className="field-grid">
              <div>
                <label htmlFor="calories">Calorie target</label>
                <input
                  id="calories"
                  inputMode="decimal"
                  placeholder="2400.0"
                  maxLength={128}
                  required
                  value={calorieTarget}
                  onChange={(event) => setCalories(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="protein">Protein target (g)</label>
                <input
                  id="protein"
                  inputMode="decimal"
                  placeholder="119.00"
                  maxLength={128}
                  required
                  value={proteinTarget}
                  onChange={(event) => setProtein(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="date">Local date (optional)</label>
                <input
                  id="date"
                  type="date"
                  value={localDate}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="timezone">Timezone (optional)</label>
                <input
                  id="timezone"
                  placeholder="Asia/Kolkata"
                  maxLength={128}
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </div>
            </div>
            <button type="submit">
              {state.status === "loading" ? "Creating…" : "Create FoodDay"}
            </button>
          </fieldset>
        </form>
        {state.status === "loading" && (
          <p role="status">Confirming your FoodDay…</p>
        )}
        {state.error && (
          <div className="error">
            <p role="alert">{state.error.message}</p>
            {state.error.retryable && (
              <>
                <p>
                  The original inputs are held for this retry. Creation may
                  already have succeeded.
                </p>
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => void client.retry()}
                >
                  Retry same request
                </button>
              </>
            )}
          </div>
        )}
      </section>
      {state.result && (
        <section className="card result" aria-labelledby="result-heading">
          <h2 id="result-heading">FoodDay result</h2>
          <p role="status" className="disposition">
            {state.result.disposition}
          </p>
          <dl>
            {Object.entries({
              "Calorie target": state.result.foodDay.calorieTarget,
              "Protein target (g)": state.result.foodDay.proteinTarget,
              "Local date": state.result.foodDay.localDate ?? "Not supplied",
              Timezone: state.result.foodDay.timezone ?? "Not supplied",
              Status: state.result.foodDay.status,
              Completeness: state.result.foodDay.completeness,
            }).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p>
            A new submission is a new explicit intent, even for the same date.
          </p>
        </section>
      )}
    </>
  );
}
