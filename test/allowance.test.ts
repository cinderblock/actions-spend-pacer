import { describe, expect, test } from "bun:test";
import { allowanceAt, catchUpDay, daysInMonthUtc } from "../src/allowance.ts";
import { summarizeUsage, usagePath } from "../src/billing.ts";

const at = (iso: string) => new Date(iso);

describe("allowanceAt", () => {
  test("daily rate counts today in full", () => {
    expect(allowanceAt(at("2026-11-01T00:00:00Z"), { dailyRate: 1 }).amount).toBe(1);
    expect(allowanceAt(at("2026-11-11T02:55:00Z"), { dailyRate: 1 }).amount).toBe(11);
    expect(allowanceAt(at("2026-11-30T23:59:59Z"), { dailyRate: 1.5 }).amount).toBe(45);
  });

  test("uses the UTC day, not local", () => {
    // 2026-11-10 6:55 PM PST is already Nov 11 in UTC.
    const a = allowanceAt(at("2026-11-10T18:55:00-08:00"), { dailyRate: 1 });
    expect(a.day).toBe(11);
    expect(a.month).toBe(11);
  });

  test("monthly budget prorates by days in month", () => {
    expect(allowanceAt(at("2026-11-15T12:00:00Z"), { monthlyBudget: 30 }).amount).toBe(15);
    expect(allowanceAt(at("2026-12-31T12:00:00Z"), { monthlyBudget: 31 }).amount).toBe(31);
    expect(allowanceAt(at("2028-02-29T12:00:00Z"), { monthlyBudget: 29 }).amount).toBe(29);
    expect(allowanceAt(at("2026-11-10T12:00:00Z"), { monthlyBudget: 20 }).amount).toBe(6.6667);
  });

  test("rejects both or neither, and negatives", () => {
    expect(() => allowanceAt(new Date(), {})).toThrow();
    expect(() => allowanceAt(new Date(), { dailyRate: 1, monthlyBudget: 30 })).toThrow();
    expect(() => allowanceAt(new Date(), { dailyRate: -1 })).toThrow();
  });

  test("days in month", () => {
    expect(daysInMonthUtc(2026, 2)).toBe(28);
    expect(daysInMonthUtc(2028, 2)).toBe(29);
    expect(daysInMonthUtc(2026, 11)).toBe(30);
  });
});

describe("catchUpDay", () => {
  const a = allowanceAt(at("2026-11-11T03:00:00Z"), { dailyRate: 1 });
  test("first day the allowance covers spend + headroom", () => {
    expect(catchUpDay(a, 16.53, 0.5)).toBe(18); // 17.03 → day 18
    expect(catchUpDay(a, 16, 0)).toBe(16);
  });
  test("already caught up → today", () => expect(catchUpDay(a, 3, 0.5)).toBe(11));
  test("not this month → undefined", () => expect(catchUpDay(a, 45, 0)).toBeUndefined());
  test("grants bring catch-up forward", () => expect(catchUpDay(a, 16.53, 0.5, 5)).toBe(13));
});

describe("summarizeUsage", () => {
  const item = (date: string, product: string, net: number, repo?: string, sku = "Actions Linux") => ({
    date,
    product,
    sku,
    quantity: 1,
    unitType: "Minutes",
    grossAmount: net,
    discountAmount: 0,
    netAmount: net,
    repositoryName: repo,
  });
  test("sums net Actions spend for the month only", () => {
    const s = summarizeUsage(
      [
        item("2026-11-07T00:00:00Z", "actions", 0.966, "ops"),
        item("2026-11-10T00:00:00Z", "actions", 9.938, "apitorrent", "Actions macOS 3-core"),
        item("2026-11-10T00:00:00Z", "actions", 0, "other"),
        item("2026-11-10T00:00:00Z", "copilot", 5, "x"),
        item("2026-10-31T00:00:00Z", "actions", 100, "ops"),
        item("2026-11-11T00:00:00Z", "Actions", 0.1),
      ],
      2026,
      11,
    );
    expect(s.total).toBe(11.004);
    expect(s.byRepo).toEqual({ ops: 0.966, apitorrent: 9.938, "(no repository)": 0.1 });
    expect(s.byDay["2026-11-10"]).toBe(9.938);
    expect(s.bySku["Actions macOS 3-core"]).toBe(9.938);
  });
  test("always passes year and month", () => {
    expect(usagePath("user", "me", 2026, 11)).toBe("/users/me/settings/billing/usage?year=2026&month=11");
    expect(usagePath("org", "acme", 2026, 1)).toBe("/organizations/acme/settings/billing/usage?year=2026&month=1");
  });
});
