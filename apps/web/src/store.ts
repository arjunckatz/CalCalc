import {
  combineReducers,
  configureStore,
  createAsyncThunk,
  createSlice,
  type PayloadAction,
  type UnknownAction,
} from "@reduxjs/toolkit";
import { ApiError, type ApiClient } from "./api";
import type { AuthGateway, BrowserSession } from "./auth";
import type {
  ClientError,
  CreateFoodDayCommand,
  CreateFoodDayResult,
} from "./contracts";

interface Attempt {
  key: string;
  command: CreateFoodDayCommand;
}
interface AuthState {
  session: BrowserSession | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
}
interface FoodDayState {
  status: "idle" | "loading" | "succeeded" | "failed";
  result: CreateFoodDayResult | null;
  error: ClientError | null;
  attempt: Attempt | null;
  requestId: string | null;
}
export interface WebState {
  auth: AuthState;
  foodDay: FoodDayState;
}
interface Dependencies {
  auth: AuthGateway;
  api: ApiClient;
  newKey: () => string;
}
const initialFoodDay: FoodDayState = {
  status: "idle",
  result: null,
  error: null,
  attempt: null,
  requestId: null,
};

const authSlice = createSlice({
  name: "auth",
  initialState: {
    session: null,
    ready: false,
    busy: false,
    error: null,
  } as AuthState,
  reducers: {
    sessionChanged(state, action: PayloadAction<BrowserSession | null>) {
      state.session = action.payload;
      state.ready = true;
    },
    finished(state) {
      state.busy = false;
      state.error = null;
    },
    started(state) {
      state.busy = true;
      state.error = null;
    },
    failed(state, action: PayloadAction<string>) {
      state.ready = true;
      state.busy = false;
      state.error = action.payload;
    },
  },
});

const sendCreation = createAsyncThunk<
  CreateFoodDayResult,
  Attempt,
  { state: WebState; extra: Dependencies; rejectValue: ClientError }
>(
  "foodDay/create",
  async (attempt, { getState, extra, rejectWithValue, signal }) => {
    const session = getState().auth.session;
    if (!session)
      return rejectWithValue({
        kind: "unauthenticated",
        message: "Sign in before creating a FoodDay.",
        retryable: false,
      });
    try {
      return await extra.api.createFoodDay(
        attempt.command,
        session.accessToken,
        attempt.key,
        signal,
      );
    } catch (error) {
      return rejectWithValue(
        error instanceof ApiError
          ? error.detail
          : {
              kind: "server",
              message: "Creation is unconfirmed. Retry the same request.",
              retryable: true,
            },
      );
    }
  },
  {
    condition: (_attempt, { getState }) =>
      getState().auth.session !== null &&
      !getState().auth.busy &&
      getState().foodDay.status !== "loading",
  },
);
const foodDaySlice = createSlice({
  name: "foodDay",
  initialState: initialFoodDay,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(sendCreation.pending, (state, action) => {
      state.status = "loading";
      state.requestId = action.meta.requestId;
      state.attempt = action.meta.arg;
      state.error = null;
      state.result = null;
    });
    builder.addCase(sendCreation.fulfilled, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.status = "succeeded";
      state.result = action.payload;
      state.attempt = null;
      state.requestId = null;
    });
    builder.addCase(sendCreation.rejected, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.status = "failed";
      state.requestId = null;
      state.error = action.payload ?? {
        kind: "network",
        message: "Creation was interrupted. Retry the same request.",
        retryable: true,
      };
      if (!state.error.retryable) state.attempt = null;
    });
  },
});
const combined = combineReducers({
  auth: authSlice.reducer,
  foodDay: foodDaySlice.reducer,
});

export function createWebClient(dependencies: Dependencies) {
  const store = configureStore({
    reducer(state: WebState | undefined, action: UnknownAction) {
      if (
        state &&
        authSlice.actions.sessionChanged.match(action) &&
        state.auth.session?.subject !== action.payload?.subject
      ) {
        // Account changes invalidate prior responses and in-memory retry handles.
        state = { ...state, foodDay: initialFoodDay };
      }
      return combined(state, action);
    },
    middleware: (defaults) =>
      defaults({ thunk: { extraArgument: dependencies } }),
    devTools: false,
  });
  let authVersion = 0;
  // Session notifications do not finish explicit auth actions. Identity changes
  // only invalidate their session writes; each action still settles its progress.
  let identityVersion = 0;
  let notificationVersion = 0;
  return {
    store,
    connect() {
      let active = true;
      const version = authVersion;
      const notifications = notificationVersion;
      const unsubscribe = dependencies.auth.subscribe((session) => {
        if (!active) return;
        notificationVersion += 1;
        if (store.getState().auth.session?.subject !== session?.subject)
          identityVersion += 1;
        store.dispatch(authSlice.actions.sessionChanged(session));
      });
      void dependencies.auth
        .restore()
        .then((session) => {
          if (
            active &&
            version === authVersion &&
            notifications === notificationVersion
          )
            store.dispatch(authSlice.actions.sessionChanged(session));
        })
        .catch(() => {
          if (
            active &&
            version === authVersion &&
            notifications === notificationVersion
          )
            store.dispatch(
              authSlice.actions.failed(
                "Could not restore your session. Please sign in.",
              ),
            );
        });
      return () => {
        active = false;
        authVersion += 1;
        unsubscribe();
      };
    },
    async signIn(email: string, password: string) {
      const version = ++authVersion;
      const identity = identityVersion;
      store.dispatch(authSlice.actions.started());
      try {
        const session = await dependencies.auth.signIn(email, password);
        if (version === authVersion) {
          if (identity === identityVersion)
            store.dispatch(authSlice.actions.sessionChanged(session));
          store.dispatch(authSlice.actions.finished());
        }
      } catch {
        if (version === authVersion && identity === identityVersion)
          store.dispatch(
            authSlice.actions.failed(
              "Sign-in failed. Check your credentials and try again.",
            ),
          );
        else if (version === authVersion)
          store.dispatch(authSlice.actions.finished());
      }
    },
    async signOut() {
      const version = ++authVersion;
      const identity = identityVersion;
      store.dispatch(authSlice.actions.started());
      try {
        await dependencies.auth.signOut();
        if (version === authVersion) {
          if (identity === identityVersion)
            store.dispatch(authSlice.actions.sessionChanged(null));
          store.dispatch(authSlice.actions.finished());
        }
      } catch {
        if (version === authVersion && identity === identityVersion)
          store.dispatch(
            authSlice.actions.failed("Could not sign out. Please try again."),
          );
        else if (version === authVersion)
          store.dispatch(authSlice.actions.finished());
      }
    },
    create(command: CreateFoodDayCommand) {
      const state = store.getState();
      if (
        !state.auth.session ||
        state.auth.busy ||
        state.foodDay.status === "loading" ||
        state.foodDay.attempt !== null
      )
        return;
      // Capture the exact command so edits can never change an uncertain retry.
      return store.dispatch(
        sendCreation({ key: dependencies.newKey(), command: { ...command } }),
      );
    },
    retry() {
      const state = store.getState();
      if (state.foodDay.error?.retryable && state.foodDay.attempt)
        return store.dispatch(sendCreation(state.foodDay.attempt));
      return undefined;
    },
  };
}
export type WebClient = ReturnType<typeof createWebClient>;
