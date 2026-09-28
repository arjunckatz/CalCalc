import { describe, expect, it } from "vitest";

import { createApiHostFromEnvironment } from "./host.js";

const environment = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "publishable-test-key",
  OPENAI_API_KEY: "openai-test-key",
  OPENAI_MODEL: "test-model",
} satisfies NodeJS.ProcessEnv;

describe("createApiHostFromEnvironment", () => {
  it.each(Object.keys(environment))(
    "fails before construction when %s is missing or blank",
    (name) => {
      const missing = { ...environment, [name]: undefined };
      const blank = { ...environment, [name]: "   " };
      for (const value of [missing, blank]) {
        expect(() => createApiHostFromEnvironment(value)).toThrow(
          `${name} is required to construct the API host.`,
        );
      }
    },
  );

  it("constructs the conversational route without opening a connection or listener", async () => {
    const host = createApiHostFromEnvironment(environment);
    expect(host.app.server.listening).toBe(false);
    expect(
      host.app.hasRoute({
        method: "POST",
        url: "/v1/food-days/:foodDayId/turns",
      }),
    ).toBe(true);
    expect(host.postgres.pool.totalCount).toBe(0);
    await host.close();
  });
});
