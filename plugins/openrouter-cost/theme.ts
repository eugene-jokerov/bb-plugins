/**
 * Plain-text formatting shared by the nav page, the Info section and the
 * sidebar badge. Deliberately free of imports so it never pulls server code
 * into the frontend bundle.
 */

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.0005) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(0)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
