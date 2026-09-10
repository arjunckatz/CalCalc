export interface PublicConfig {
  supabaseUrl: string;
  supabaseBrowserKey: string;
  apiUrl: string;
}

export function readPublicConfig(
  env: Record<string, string | undefined>,
): PublicConfig {
  const supabaseUrl = env.VITE_SUPABASE_URL ?? "";
  const publishable = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  const anon = env.VITE_SUPABASE_ANON_KEY ?? "";
  const apiUrl = env.VITE_CALCALC_API_URL ?? "";
  if (Boolean(publishable) === Boolean(anon)) {
    throw new Error(
      "Configure exactly one browser key: publishable or legacy anon.",
    );
  }
  if (
    publishable
      ? !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishable)
      : !isLegacyAnonKey(anon)
  ) {
    throw new Error("Invalid browser key configuration.");
  }
  for (const value of [supabaseUrl, apiUrl]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Configure valid public HTTP(S) URLs.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Public HTTP(S) URLs must not contain credentials, queries, or fragments.",
      );
    }
  }
  return { supabaseUrl, supabaseBrowserKey: publishable || anon, apiUrl };
}

// Build-time configuration screening, NOT signature verification or user authentication.
// Only explicitly selected legacy anon keys qualify; arbitrary user/service JWTs do not.
function isLegacyAnonKey(key: string): boolean {
  if (
    key.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(key)
  )
    return false;
  try {
    const [headerText, payloadText] = key.split(".");
    const header: unknown = JSON.parse(
      Buffer.from(headerText!, "base64url").toString("utf8"),
    );
    const payload: unknown = JSON.parse(
      Buffer.from(payloadText!, "base64url").toString("utf8"),
    );
    if (!record(header) || !record(payload)) return false;
    return (
      header.alg === "HS256" &&
      header.typ === "JWT" &&
      payload.role === "anon" &&
      (payload.iss === "supabase" || payload.iss === "supabase-demo") &&
      typeof payload.iat === "number" &&
      Number.isSafeInteger(payload.iat) &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp > payload.iat
    );
  } catch {
    return false;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
