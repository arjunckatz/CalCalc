import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "@jest/globals";
import { App } from "./App";
import { createApiClient } from "./api";
import type { AuthGateway, BrowserSession } from "./auth";
import { createWebClient } from "./store";

const session: BrowserSession = {
  accessToken: "test-access-token",
  subject: "test-subject-a",
};
const result = {
  disposition: "CREATED",
  foodDay: {
    id: "day-a",
    status: "OPEN",
    completeness: "UNKNOWN",
    calorieTarget: "685.1075",
    proteinTarget: "41.0025",
    localDate: null,
    timezone: null,
    openedAt: "2026-09-10T00:00:00Z",
    closedAt: null,
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
  },
};
function response(status = 201, body: unknown = result): Response {
  return { status, json: async () => body } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(signedIn = true, restored?: Promise<BrowserSession | null>) {
  let notify: (session: BrowserSession | null) => void = () => undefined;
  const auth = {
    restore: jest
      .fn<AuthGateway["restore"]>()
      .mockImplementation(
        () => restored ?? Promise.resolve(signedIn ? session : null),
      ),
    subscribe: jest
      .fn<AuthGateway["subscribe"]>()
      .mockImplementation((callback) => {
        notify = callback;
        return unsubscribe;
      }),
    signIn: jest.fn<AuthGateway["signIn"]>().mockResolvedValue(session),
    signOut: jest.fn<AuthGateway["signOut"]>().mockResolvedValue(undefined),
  };
  const unsubscribe = jest.fn();
  const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response());
  const newKey = jest
    .fn<() => string>()
    .mockReturnValueOnce("intent-one")
    .mockReturnValueOnce("intent-two")
    .mockReturnValue("intent-next");
  const client = createWebClient({
    auth,
    api: createApiClient("https://api.example/", fetchMock),
    newKey,
  });
  const view = render(<App client={client} />);
  return {
    ...view,
    auth,
    fetchMock,
    newKey,
    client,
    user: userEvent.setup(),
    emit: (value: BrowserSession | null) => act(() => notify(value)),
  };
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Create a FoodDay" });
  await user.type(
    screen.getByRole("textbox", { name: "Calorie target" }),
    "685.107500",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Protein target (g)" }),
    "41.002500",
  );
}
async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create FoodDay" }));
}

describe("experimental FoodDay client", () => {
  it("shows the accessible login form when unauthenticated", async () => {
    setup(false);
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeVisible();
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.queryByRole("heading", { name: "Create a FoodDay" }),
    ).not.toBeInTheDocument();
  });

  it("signs in through the auth boundary without retaining credentials in Redux", async () => {
    const { user, auth, client } = setup(false);
    await user.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "private-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("heading", { name: "Create a FoodDay" }),
    ).toBeVisible();
    expect(auth.signIn).toHaveBeenCalledWith(
      "person@example.com",
      "private-password",
    );
    expect(JSON.stringify(client.store.getState())).not.toContain(
      "private-password",
    );
  });

  it("sanitizes auth failures and clears the password field", async () => {
    const { auth, user } = setup(false);
    auth.signIn.mockRejectedValueOnce(
      new Error("private-stack private-password"),
    );
    await user.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "private-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in failed. Check your credentials",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(document.body).not.toHaveTextContent("private-stack");
  });

  it("disables login while authentication is pending", async () => {
    const pending = deferred<BrowserSession>();
    const { auth, user } = setup(false);
    auth.signIn.mockReturnValueOnce(pending.promise);
    await user.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await act(async () => pending.resolve(session));
    expect(
      await screen.findByRole("heading", { name: "Create a FoodDay" }),
    ).toBeVisible();
  });

  it("sends exact text, Bearer identity and one opaque key; renders the authoritative 201 DTO", async () => {
    const { user, fetchMock } = setup();
    await fill(user);
    await user.type(
      screen.getByLabelText("Local date (optional)"),
      "2026-09-10",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Timezone (optional)" }),
      "Asia/Kolkata",
    );
    await submit(user);
    expect(await screen.findByText("CREATED")).toBeVisible();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/food-days");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-access-token",
        "Idempotency-Key": "intent-one",
      },
      credentials: "omit",
      redirect: "error",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      calorieTarget: "685.107500",
      proteinTarget: "41.002500",
      localDate: "2026-09-10",
      timezone: "Asia/Kolkata",
    });
    const rendered = screen.getByRole("region", { name: "FoodDay result" });
    expect(within(rendered).getByText("685.1075")).toBeVisible();
    expect(within(rendered).getByText("41.0025")).toBeVisible();
    expect(within(rendered).getByText("OPEN")).toBeVisible();
    expect(within(rendered).getByText("UNKNOWN")).toBeVisible();
    expect(document.body).not.toHaveTextContent(session.accessToken);
    expect(init!.body).not.toMatch(
      /userId|operationKey|fingerprint|test-subject/,
    );
  });

  it("sends null for blank optional metadata", async () => {
    const { user, fetchMock } = setup();
    await fill(user);
    await submit(user);
    expect(await screen.findByText("CREATED")).toBeVisible();
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      calorieTarget: "685.107500",
      proteinTarget: "41.002500",
      localDate: null,
      timezone: null,
    });
    expect(screen.getAllByText("Not supplied")).toHaveLength(2);
  });

  it("visibly distinguishes a 200 REPLAYED response", async () => {
    const { user, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      response(200, { ...result, disposition: "REPLAYED" }),
    );
    await fill(user);
    await submit(user);
    expect(await screen.findByText("REPLAYED")).toBeVisible();
    expect(screen.queryByText("CREATED")).not.toBeInTheDocument();
  });

  it("prevents duplicate submissions while creation is pending", async () => {
    const pending = deferred<Response>();
    const { user, fetchMock } = setup();
    fetchMock.mockReturnValueOnce(pending.promise);
    await fill(user);
    await submit(user);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Calorie target" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Creating…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response()));
    expect(await screen.findByText("CREATED")).toBeVisible();
  });

  it("retains exact command and key for an explicit retry after a network failure", async () => {
    const { user, fetchMock, newKey } = setup();
    fetchMock.mockRejectedValueOnce(new Error("private-token network stack"));
    fetchMock.mockResolvedValueOnce(
      response(200, { ...result, disposition: "REPLAYED" }),
    );
    await fill(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not confirm creation",
    );
    expect(document.body).not.toHaveTextContent("private-token");
    expect(
      screen.getByRole("textbox", { name: "Calorie target" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    expect(await screen.findByText("REPLAYED")).toBeVisible();
    const first = fetchMock.mock.calls[0]![1]!;
    const retry = fetchMock.mock.calls[1]![1]!;
    expect(retry.body).toBe(first.body);
    expect(retry.headers).toEqual(first.headers);
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it("generates a new key for a deliberate new creation after success", async () => {
    const { user, fetchMock, newKey } = setup();
    await fill(user);
    await submit(user);
    await screen.findByText("CREATED");
    await submit(user);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      "Idempotency-Key": "intent-one",
    });
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
      "Idempotency-Key": "intent-two",
    });
    expect(newKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "The request was rejected"],
    [401, "Your session was rejected"],
    [409, "Idempotency conflict"],
  ] as const)(
    "handles HTTP %s without exposing server errors",
    async (status, message) => {
      const { user, fetchMock } = setup();
      fetchMock.mockResolvedValueOnce(
        response(status, { error: { message: "private-server-stack" } }),
      );
      await fill(user);
      await submit(user);
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(document.body).not.toHaveTextContent("private-server-stack");
      expect(
        screen.queryByRole("button", { name: "Retry same request" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([500, 502])(
    "keeps uncertain HTTP %s outcomes retryable with the original key",
    async (status) => {
      const { user, fetchMock } = setup();
      fetchMock.mockResolvedValueOnce(response(status));
      await fill(user);
      await submit(user);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "server could not confirm",
      );
      await user.click(
        screen.getByRole("button", { name: "Retry same request" }),
      );
      expect(await screen.findByText("CREATED")).toBeVisible();
      expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
        "Idempotency-Key": "intent-one",
      });
    },
  );

  it("does not treat malformed success data or numeric targets as confirmed creation", async () => {
    const { user, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      response(201, {
        ...result,
        foodDay: { ...result.foodDay, calorieTarget: 685.1075 },
      }),
    );
    await fill(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "unexpected response",
    );
    expect(
      screen.getByRole("button", { name: "Retry same request" }),
    ).toBeVisible();
    expect(screen.queryByText("CREATED")).not.toBeInTheDocument();
  });

  it.each(["status", "completeness"] as const)(
    "rejects array-valued %s without confirming success or losing retry identity",
    async (field) => {
      const { user, fetchMock, client, newKey } = setup();
      fetchMock.mockResolvedValueOnce(
        response(201, {
          ...result,
          foodDay: { ...result.foodDay, [field]: [result.foodDay[field]] },
        }),
      );
      await fill(user);
      await submit(user);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "unexpected response",
      );
      expect(
        screen.queryByRole("region", { name: "FoodDay result" }),
      ).not.toBeInTheDocument();
      expect(client.store.getState().foodDay.result).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Retry same request" }),
      );
      expect(await screen.findByText("CREATED")).toBeVisible();
      expect(fetchMock.mock.calls[1]![1]!.body).toBe(
        fetchMock.mock.calls[0]![1]!.body,
      );
      expect(fetchMock.mock.calls[1]![1]!.headers).toEqual(
        fetchMock.mock.calls[0]![1]!.headers,
      );
      expect(newKey).toHaveBeenCalledTimes(1);
    },
  );

  it("signs out and clears the prior result", async () => {
    const { user, auth, client } = setup();
    await fill(user);
    await submit(user);
    await screen.findByText("CREATED");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeVisible();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(client.store.getState().foodDay.result).toBeNull();
    expect(client.store.getState().auth.session).toBeNull();
  });

  it("ignores a late creation response after account change", async () => {
    const pending = deferred<Response>();
    const { user, fetchMock, emit, client } = setup();
    fetchMock.mockReturnValueOnce(pending.promise);
    await fill(user);
    await submit(user);
    emit({ subject: "test-subject-b", accessToken: "token-b" });
    await act(async () => pending.resolve(response()));
    expect(screen.queryByText("CREATED")).not.toBeInTheDocument();
    expect(client.store.getState().foodDay.result).toBeNull();
    expect(screen.getByRole("textbox", { name: "Calorie target" })).toHaveValue(
      "",
    );
  });

  it("keeps the pending retry across same-account token refresh and uses the new token", async () => {
    const { user, fetchMock, emit } = setup();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await fill(user);
    await submit(user);
    await screen.findByRole("alert");
    emit({ ...session, accessToken: "refreshed-token" });
    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    expect(await screen.findByText("CREATED")).toBeVisible();
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
      Authorization: "Bearer refreshed-token",
      "Idempotency-Key": "intent-one",
    });
  });

  it("does not overwrite an auth event with stale session restoration", async () => {
    const restored = deferred<BrowserSession | null>();
    const { emit, unmount, auth } = setup(false, restored.promise);
    expect(screen.getByRole("status")).toHaveTextContent("Restoring session");
    emit(session);
    await act(async () => restored.resolve(null));
    expect(
      screen.getByRole("heading", { name: "Create a FoodDay" }),
    ).toBeVisible();
    unmount();
    expect(auth.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps sign-out busy through same-account refresh until completion", async () => {
    const pending = deferred<void>();
    const { user, auth, emit } = setup();
    auth.signOut.mockReturnValueOnce(pending.promise);
    await fill(user);
    await submit(user);
    await screen.findByText("CREATED");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    emit({ ...session, accessToken: "refreshed-token" });
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create FoodDay" }),
    ).toBeDisabled();
    await act(async () => pending.resolve());
    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("region", { name: "FoodDay result" }),
    ).not.toBeInTheDocument();
  });

  it("handles sign-out failure after refresh and preserves the pending FoodDay retry", async () => {
    const pending = deferred<void>();
    const { user, auth, emit, fetchMock } = setup();
    auth.signOut.mockReturnValueOnce(pending.promise);
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await fill(user);
    await submit(user);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    emit({ ...session, accessToken: "refreshed-token" });
    expect(
      screen.getByRole("button", { name: "Retry same request" }),
    ).toBeDisabled();
    await act(async () => pending.reject(new Error("private failure")));
    expect(
      screen.getByText("Could not sign out. Please try again."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await user.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    expect(await screen.findByText("CREATED")).toBeVisible();
    expect(fetchMock.mock.calls[1]![1]!.body).toBe(
      fetchMock.mock.calls[0]![1]!.body,
    );
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
      Authorization: "Bearer refreshed-token",
      "Idempotency-Key": "intent-one",
    });
  });

  it("clears another account's pending retry and ignores late sign-out completion", async () => {
    const pending = deferred<void>();
    const { user, auth, emit, fetchMock } = setup();
    auth.signOut.mockReturnValueOnce(pending.promise);
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await fill(user);
    await submit(user);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    emit({ subject: "account-b", accessToken: "token-b" });
    expect(
      screen.queryByRole("button", { name: "Retry same request" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Calorie target" })).toHaveValue(
      "",
    );
    await act(async () => pending.resolve());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await fill(user);
    await submit(user);
    expect(await screen.findByText("CREATED")).toBeVisible();
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
      Authorization: "Bearer token-b",
      "Idempotency-Key": "intent-two",
    });
  });

  it("does not restore an old account from a late sign-in completion", async () => {
    const pending = deferred<BrowserSession>();
    const { user, auth, emit, fetchMock } = setup(false);
    auth.signIn.mockReturnValueOnce(pending.promise);
    await user.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    emit({ subject: "account-b", accessToken: "token-b" });
    await act(async () => pending.resolve(session));
    await fill(user);
    await submit(user);
    expect(await screen.findByText("CREATED")).toBeVisible();
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer token-b",
    });
  });

  it("keeps sign-in progress through a same-identity notification", async () => {
    const pending = deferred<BrowserSession>();
    const { user, auth, emit } = setup(false);
    auth.signIn.mockReturnValueOnce(pending.promise);
    await user.type(
      await screen.findByRole("textbox", { name: "Email" }),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    emit(null);
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await act(async () => pending.resolve(session));
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
  });
});
