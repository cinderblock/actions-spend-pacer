import type { AllowanceConfig } from "./types.ts";

export interface Allowance {
  year: number;
  /** 1-12 */
  month: number;
  /** UTC day of month, 1-based. Today counts in full. */
  day: number;
  daysInMonth: number;
  /** USD allowed to be spent month-to-date. */
  amount: number;
  /** USD added per day. */
  perDay: number;
}

export function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function validateAllowanceConfig(cfg: AllowanceConfig): void {
  const hasDaily = cfg.dailyRate !== undefined;
  const hasMonthly = cfg.monthlyBudget !== undefined;
  if (hasDaily === hasMonthly) throw new Error("Set exactly one of daily-rate or monthly-budget.");
  const v = (hasDaily ? cfg.dailyRate : cfg.monthlyBudget) as number;
  if (!Number.isFinite(v) || v < 0) throw new Error(`Allowance must be a non-negative number, got ${v}.`);
}

/**
 * Running allowance for the billing month containing `now`. GitHub bills by UTC day and
 * the month rolls over at UTC midnight, so everything here is UTC.
 */
export function allowanceAt(now: Date, cfg: AllowanceConfig): Allowance {
  validateAllowanceConfig(cfg);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const daysInMonth = daysInMonthUtc(year, month);
  const perDay = cfg.dailyRate ?? (cfg.monthlyBudget as number) / daysInMonth;
  return { year, month, day, daysInMonth, perDay, amount: roundCents(perDay * day) };
}

/** Round to a hundredth of a cent so float noise never flips a comparison. */
export function roundCents(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * First UTC day on which the allowance reaches `spend + headroom`, assuming no further
 * spend. Returns undefined if that is not in the current month (the month reset resumes).
 */
export function catchUpDay(a: Allowance, spend: number, headroom: number): number | undefined {
  if (a.perDay <= 0) return undefined;
  const day = Math.ceil(roundCents((spend + headroom) / a.perDay));
  return day <= a.daysInMonth ? Math.max(day, a.day) : undefined;
}
