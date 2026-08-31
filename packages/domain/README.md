# CAL CALC domain

This package is the pure, deterministic accounting core. It has no dependency on UI, HTTP, database, environment, or model-provider code.

Nutrition DTOs use normalized finite decimal strings. `decimal.js` is used internally, so canonical calorie and macro arithmetic never uses JavaScript floating-point values. Display rounding is an explicit half-up formatting helper and never changes a stored value.

Each food entry preserves both `derivedNutrition` (from its basis and quantity) and `workingNutrition` (the ledger value). A user override changes only the working nutrient values supplied; known non-overridden nutrients continue to derive from the source calculation.

Entries start at revision `1`. Every successful meaningful entry mutation returns a new entry at the next revision. A mismatched expected revision returns a typed revision conflict without changing the current entry.

Only non-deleted `CONFIRMED_CONSUMED` entries contribute to a day summary. The in-memory idempotency store documents retry semantics for this layer, but durable operation-id enforcement belongs to a future PostgreSQL persistence milestone.
