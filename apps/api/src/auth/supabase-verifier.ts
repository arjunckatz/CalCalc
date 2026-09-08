import { createClient } from "@supabase/supabase-js";

import {
  AuthenticationError,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
} from "./authorization.js";

interface ClaimsVerifier {
  getClaims(token: string): Promise<{
    readonly data: { readonly claims: { readonly sub?: unknown } } | null;
    readonly error: unknown;
  }>;
}

export interface SupabaseAccessTokenVerifierConfig {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
}

export class SupabaseAccessTokenVerifier implements AccessTokenVerifier {
  constructor(private readonly auth: ClaimsVerifier) {}

  async verifyAccessToken(token: string): Promise<AuthenticatedIdentity> {
    // Never let an empty token select the SDK's implicit session fallback.
    if (token.trim() === "") {
      throw new AuthenticationError("INVALID_ACCESS_TOKEN");
    }

    let response: Awaited<ReturnType<ClaimsVerifier["getClaims"]>>;
    try {
      response = await this.auth.getClaims(token);
    } catch {
      // SDK errors can contain credentials: do not retain their text or cause.
      throw new AuthenticationError("INVALID_ACCESS_TOKEN");
    }
    if (response.error !== null || response.data === null) {
      throw new AuthenticationError("INVALID_ACCESS_TOKEN");
    }

    const subject = response.data.claims?.sub;
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new AuthenticationError("INVALID_VERIFIED_IDENTITY");
    }
    return { userId: subject };
  }
}

export function createSupabaseAccessTokenVerifier(
  config: SupabaseAccessTokenVerifierConfig,
): SupabaseAccessTokenVerifier {
  if (config.supabaseUrl.trim() === "") {
    throw new TypeError("Supabase URL must not be blank.");
  }
  if (config.supabasePublishableKey.trim() === "") {
    throw new TypeError("Supabase publishable key must not be blank.");
  }
  const client = createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return new SupabaseAccessTokenVerifier(client.auth);
}
