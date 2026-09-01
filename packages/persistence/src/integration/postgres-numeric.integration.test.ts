import { Client, type QueryResultRow } from "pg";
import { expect, it } from "vitest";

interface NumericTransportRow extends QueryResultRow {
  readonly calories: unknown;
  readonly protein: unknown;
  readonly basisCalories: unknown;
  readonly fractionalAmount: unknown;
  readonly numericType: unknown;
  readonly nutrition: unknown;
  readonly nutritionWithoutProtein: unknown;
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL numeric transport integration test.",
  );
}

it("transports PostgreSQL numeric and JSONB decimal strings without Number conversion", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<NumericTransportRow>(`
      select
        685.1075::numeric as "calories",
        41.0025::numeric as "protein",
        249.13::numeric as "basisCalories",
        0.1::numeric as "fractionalAmount",
        pg_typeof(685.1075::numeric)::text as "numericType",
        jsonb_build_object(
          'calories', '685.1075',
          'protein', '41.0025'
        ) as "nutrition",
        jsonb_build_object('calories', '249.13') as "nutritionWithoutProtein"
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error("PostgreSQL returned no row.");

    for (const [column, expected] of [
      ["calories", "685.1075"],
      ["protein", "41.0025"],
      ["basisCalories", "249.13"],
      ["fractionalAmount", "0.1"],
    ] as const) {
      expect(typeof row[column]).toBe("string");
      expect(row[column]).toBe(expected);
      expect(typeof row[column]).not.toBe("number");
    }
    expect(row.numericType).toBe("numeric");

    expect(row.nutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
    });
    const nutrition = row.nutrition as Record<string, unknown>;
    expect(typeof nutrition.calories).toBe("string");
    expect(typeof nutrition.protein).toBe("string");

    expect(row.nutritionWithoutProtein).toEqual({ calories: "249.13" });
    const nutritionWithoutProtein = row.nutritionWithoutProtein as Record<
      string,
      unknown
    >;
    expect(
      Object.prototype.hasOwnProperty.call(nutritionWithoutProtein, "protein"),
    ).toBe(false);
    expect(nutritionWithoutProtein.protein).toBeUndefined();
  } finally {
    await client.end();
  }
});
