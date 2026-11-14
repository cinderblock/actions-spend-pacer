import { validateAllowanceConfig } from "./allowance.ts";
import type { Config } from "./run.ts";

/** Read raw string inputs (action inputs or CLI flags) into a validated Config. */
function positiveHours(h: number): number {
  if (!(h > 0)) throw new Error(`control-hours must be a positive number, got ${h}.`);
  return h;
}

export function parseConfig(get: (name: string) => string | undefined, defaults: { owner?: string; repoIsPublic?: boolean }): Config {
  const s = (n: string) => get(n)?.trim() || undefined;
  const list = (n: string) =>
    (s(n) ?? "")
      .split(/[\n,]/)
      .map((x) => x.replace(/#.*$/, "").trim())
      .filter(Boolean);
  const num = (n: string) => {
    const v = s(n);
    if (v === undefined) return undefined;
    const x = Number(v.replace(/^\$/, ""));
    if (!Number.isFinite(x) || x < 0) throw new Error(`${n} must be a non-negative number, got "${v}".`);
    return x;
  };
  const bool = (n: string, d: boolean) => {
    const v = s(n)?.toLowerCase();
    if (v === undefined) return d;
    if (["true", "yes", "1", "on"].includes(v)) return true;
    if (["false", "no", "0", "off"].includes(v)) return false;
    throw new Error(`${n} must be true or false, got "${v}".`);
  };

  const owner = s("owner") ?? defaults.owner;
  if (!owner) throw new Error("owner is required.");
  const ownerType = (s("owner-type") ?? "user").toLowerCase();
  if (ownerType !== "user" && ownerType !== "org") throw new Error(`owner-type must be user or org, got "${ownerType}".`);

  const monthlyBudget = num("monthly-budget");
  const dailyRate = num("daily-rate") ?? (monthlyBudget === undefined ? 1 : undefined);
  const allowance = { dailyRate, monthlyBudget };
  validateAllowanceConfig(allowance);

  const mode = (s("mode") ?? "dry-run").toLowerCase();
  if (mode !== "dry-run" && mode !== "live") throw new Error(`mode must be dry-run or live, got "${mode}".`);

  const reposRaw = s("repos") ?? "all-private";
  const repos = reposRaw.toLowerCase() === "all-private" ? ("all-private" as const) : list("repos");

  const redactRaw = (s("redact") ?? "auto").toLowerCase();
  const redact = redactRaw === "auto" ? (defaults.repoIsPublic ?? true) : bool("redact", true);

  const timezone = s("timezone") ?? "UTC";
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }); // throws RangeError on a bad zone

  return {
    owner,
    ownerType,
    allowance,
    headroom: num("resume-headroom") ?? 0.5,
    controlHours: positiveHours(num("control-hours") ?? 4),
    repos,
    allowList: list("allow-list"),
    includeDynamic: bool("include-dynamic", false),
    mode,
    timezone,
    redact,
    webhookUrl: s("webhook-url"),
  };
}
