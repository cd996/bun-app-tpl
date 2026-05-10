/**
 * Locale-aware formatting helpers. The active i18n language drives both
 * dates and relative times so a Chinese-language user with
 * `navigator.language=en-US` sees Chinese-formatted dates instead of the
 * mixed-language UI that `Date.prototype.toLocaleDateString()` (with its
 * default of the browser locale) produces.
 *
 * Use these in place of `new Date(x).toLocaleDateString()` /
 * `toLocaleString()` everywhere a date appears in the UI.
 */

import i18n from "@/app/i18n";

function lang(): string {
  return i18n?.language || "en";
}

export function formatDate(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  return new Intl.DateTimeFormat(lang(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function formatDateTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  return new Intl.DateTimeFormat(lang(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  return new Intl.DateTimeFormat(lang(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

const RELATIVE_THRESHOLDS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

export function formatRelative(value: Date | string | number, baseline: Date = new Date()): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime()))
    return "";
  const diff = d.getTime() - baseline.getTime();
  const abs = Math.abs(diff);
  if (abs < 30_000) {
    return new Intl.RelativeTimeFormat(lang(), { numeric: "auto" }).format(0, "second");
  }
  for (const { unit, ms } of RELATIVE_THRESHOLDS) {
    if (abs >= ms) {
      const value = Math.round(diff / ms);
      return new Intl.RelativeTimeFormat(lang(), { numeric: "auto" }).format(value, unit);
    }
  }
  return new Intl.RelativeTimeFormat(lang(), { numeric: "auto" }).format(0, "second");
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(lang()).format(value);
}
