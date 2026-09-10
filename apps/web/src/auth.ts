import { createClient, type Session } from "@supabase/supabase-js";
import type { PublicConfig } from "./config";

export interface BrowserSession {
  accessToken: string;
  subject: string;
}
export interface AuthGateway {
  restore(): Promise<BrowserSession | null>;
  subscribe(callback: (session: BrowserSession | null) => void): () => void;
  signIn(email: string, password: string): Promise<BrowserSession>;
  signOut(): Promise<void>;
}
export function createBrowserAuth(config: PublicConfig): AuthGateway {
  const client = createClient(config.supabaseUrl, config.supabaseBrowserKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  const sessionView = (session: Session | null): BrowserSession | null =>
    session === null
      ? null
      : { accessToken: session.access_token, subject: session.user.id };
  return {
    async restore() {
      const { data, error } = await client.auth.getSession();
      if (error) throw new Error("Session unavailable.");
      return sessionView(data.session);
    },
    subscribe(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) =>
        callback(sessionView(session)),
      );
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error || data.session === null) throw new Error("Sign-in failed.");
      return sessionView(data.session)!;
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw new Error("Sign-out failed.");
    },
  };
}
