import { describe, expect, it } from "vitest";

import { describeFoundation } from "./index.js";

describe("workspace foundation", () => {
  it("resolves workspace package imports", () => {
    expect(describeFoundation()).toEqual(["pure-domain", "SUPABASE_URL"]);
  });
});
