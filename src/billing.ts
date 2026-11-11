import { roundCents } from "./allowance.ts";
import type { GitHub } from "./github.ts";
import type { OwnerType } from "./types.ts";

export interface UsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  netAmount: number;
  grossAmount: number;
  discountAmount: number;
  repositoryName?: string;
}

export interface Spend {
  /** Month-to-date net Actions spend, USD. */
  total: number;
  byRepo: Record<string, number>;
  bySku: Record<string, number>;
  /** Keyed by UTC date, YYYY-MM-DD. */
  byDay: Record<string, number>;
}

export function usagePath(ownerType: OwnerType, owner: string, year: number, month: number): string {
  const base = ownerType === "org" ? `/organizations/${owner}` : `/users/${owner}`;
  // Always pass year and month: without them the endpoint returns a different aggregate.
  return `${base}/settings/billing/usage?year=${year}&month=${month}`;
}

/** Sum net Actions spend for one UTC month from billing usage items. */
export function summarizeUsage(items: UsageItem[], year: number, month: number): Spend {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const spend: Spend = { total: 0, byRepo: {}, bySku: {}, byDay: {} };
  const add = (m: Record<string, number>, k: string, v: number) => (m[k] = roundCents((m[k] ?? 0) + v));
  for (const i of items) {
    if (i.product?.toLowerCase() !== "actions" || !i.date?.startsWith(prefix)) continue;
    const net = Number(i.netAmount) || 0;
    spend.total += net;
    if (net === 0) continue;
    add(spend.byRepo, i.repositoryName || "(no repository)", net);
    add(spend.bySku, i.sku, net);
    add(spend.byDay, i.date.slice(0, 10), net);
  }
  spend.total = roundCents(spend.total);
  return spend;
}

export async function fetchSpend(
  gh: GitHub,
  ownerType: OwnerType,
  owner: string,
  year: number,
  month: number,
): Promise<Spend> {
  const res = await gh.request<{ usageItems?: UsageItem[] }>("GET", usagePath(ownerType, owner, year, month));
  if (!Array.isArray(res?.usageItems)) throw new Error("Billing usage response has no usageItems array.");
  return summarizeUsage(res.usageItems, year, month);
}
