import OpenAI from "openai";
import type { FastifyInstance } from "fastify";

import { createOpenAIFoodDayTurnModel } from "./agent/providers/openai/openai-food-day-turn-model.js";
import { createFoodDayTurnRunner } from "./agent/turn/create-food-day-turn-runner.js";
import { createSupabaseAccessTokenVerifier } from "./auth/supabase-verifier.js";
import { createApiApp } from "./http/app.js";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "./postgres/runtime.js";

type ApiHostEnvironmentName =
  | "DATABASE_URL"
  | "SUPABASE_URL"
  | "SUPABASE_PUBLISHABLE_KEY"
  | "OPENAI_API_KEY"
  | "OPENAI_MODEL";

export interface ApiHost {
  readonly app: FastifyInstance;
  readonly postgres: PostgresRuntime;
  close(): Promise<void>;
}

/**
 * Explicit real-host composition. Importing this module performs no IO and reads
 * no environment values; the caller still owns TCP listen and shutdown timing.
 */
export function createApiHostFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ApiHost {
  const databaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  const supabaseUrl = requiredEnvironment(environment, "SUPABASE_URL");
  const supabasePublishableKey = requiredEnvironment(
    environment,
    "SUPABASE_PUBLISHABLE_KEY",
  );
  const openAIApiKey = requiredEnvironment(environment, "OPENAI_API_KEY");
  const openAIModel = requiredEnvironment(environment, "OPENAI_MODEL");

  const postgres = createPostgresRuntime({ connectionString: databaseUrl });
  const authVerifier = createSupabaseAccessTokenVerifier({
    supabaseUrl,
    supabasePublishableKey,
  });
  const model = createOpenAIFoodDayTurnModel({
    client: new OpenAI({ apiKey: openAIApiKey }),
    model: openAIModel,
  });
  const app = createApiApp({
    authVerifier,
    postgres: postgres.pool,
    transactionRunner: postgres.transactionRunner,
    foodDayTurn: createFoodDayTurnRunner({
      postgres: postgres.pool,
      transactionRunner: postgres.transactionRunner,
      model,
    }),
  });
  return {
    app,
    postgres,
    async close() {
      const failures: unknown[] = [];
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await postgres.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "API host shutdown failed.");
      }
    },
  };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: ApiHostEnvironmentName,
): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required to construct the API host.`);
  }
  return value.trim();
}
