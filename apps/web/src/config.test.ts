import { describe, expect, it } from "@jest/globals";
import { readPublicConfig } from "./config";

const env = {
  VITE_SUPABASE_URL: "https://project.example",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  VITE_CALCALC_API_URL: "https://api.example",
};
function legacy(role = "anon", issuer = "supabase-demo") {
  // Structural fixture only, deliberately not signed by any Supabase project.
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ role, iss: issuer, iat: 1600000000, exp: 2000000000 }),
  ).toString("base64url");
  return `${header}.${body}.${"x".repeat(43)}`;
}
describe("public browser configuration", () => {
  it("rejects missing keys with a fixed message", () => {
    expect(() => readPublicConfig({})).toThrow(
      "Configure exactly one browser key: publishable or legacy anon.",
    );
  });
  it("selects only the public allowlist", () => {
    expect(
      readPublicConfig({
        ...env,
        DATABASE_URL: "private",
        SUPABASE_SECRET_KEY: "private",
        VITE_OTHER: "private",
      }),
    ).toEqual({
      supabaseUrl: env.VITE_SUPABASE_URL,
      supabaseBrowserKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
      apiUrl: env.VITE_CALCALC_API_URL,
    });
  });
  it.each([
    "sb_secret_private",
    "eyJhbGciOiJIUzI1NiJ9.private.signature",
    "private",
  ])(
    "rejects a non-publishable credential without disclosing it (%#)",
    (key) => {
      expect(() =>
        readPublicConfig({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key }),
      ).toThrow(new Error("Invalid browser key configuration."));
    },
  );
  it.each(["supabase", "supabase-demo"])(
    "accepts a legacy anon key for issuer %s",
    (issuer) => {
      const key = legacy("anon", issuer);
      expect(
        readPublicConfig({
          ...env,
          VITE_SUPABASE_PUBLISHABLE_KEY: "",
          VITE_SUPABASE_ANON_KEY: key,
        }).supabaseBrowserKey,
      ).toBe(key);
    },
  );
  it("rejects both-set ambiguity", () => {
    expect(() =>
      readPublicConfig({ ...env, VITE_SUPABASE_ANON_KEY: legacy() }),
    ).toThrow("Configure exactly one browser key: publishable or legacy anon.");
  });
  it.each([
    legacy("service_role"),
    legacy("authenticated"),
    legacy("anon", "unrelated"),
    "sb_secret_private",
    "not-a-jwt",
  ])("rejects unsafe or arbitrary legacy credentials (%#)", (key) => {
    expect(() =>
      readPublicConfig({
        ...env,
        VITE_SUPABASE_PUBLISHABLE_KEY: "",
        VITE_SUPABASE_ANON_KEY: key,
      }),
    ).toThrow(new Error("Invalid browser key configuration."));
  });
  it("does not substitute server-only keys for a missing browser key", () => {
    expect(() =>
      readPublicConfig({
        ...env,
        VITE_SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_SECRET_KEY: "private",
      }),
    ).toThrow("Configure exactly one browser key");
  });
  it("requires the API URL separately", () => {
    expect(() =>
      readPublicConfig({ ...env, VITE_CALCALC_API_URL: "" }),
    ).toThrow(new Error("Configure valid public HTTP(S) URLs."));
  });
  it.each([
    "https://user:password@api.example",
    "javascript:alert(1)",
    "https://api.example?secret=value",
    "not a URL",
  ])("rejects unsafe URLs (%#)", (url) => {
    expect(() =>
      readPublicConfig({ ...env, VITE_CALCALC_API_URL: url }),
    ).toThrow();
  });
});
