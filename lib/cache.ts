// In-memory cache for the single-tenant dev/prod process. Entries TTL out after
// an hour. v2 would move to Redis or Railway's persistent volume so chat
// sessions survive a redeploy.
//
// Two maps:
//   - parsed:  sourceKey (content hash) → markdown + label + createdAt
//   - urls:    url → sourceKey  (so resubmitting the same URL skips LlamaParse)
//
// URL-level memoization is the load-bearing piece for iteration — without it,
// every prompt tweak forces a $0.50-$2 re-parse on Indian ARs.

import crypto from "node:crypto";

type Entry = { markdown: string; sourceLabel: string; createdAt: number };

const TTL_MS = 60 * 60 * 1000;
const parsed = new Map<string, Entry>();
const urls = new Map<string, string>();

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function put(key: string, markdown: string, sourceLabel: string): void {
  parsed.set(key, { markdown, sourceLabel, createdAt: Date.now() });
}

export function get(key: string): Entry | null {
  const entry = parsed.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    parsed.delete(key);
    return null;
  }
  return entry;
}

export function memoUrl(url: string, sourceKey: string): void {
  urls.set(url, sourceKey);
}

export function lookupUrl(url: string): string | null {
  const key = urls.get(url);
  if (!key) return null;
  // Don't return a stale URL mapping that points at a TTL'd entry.
  if (!get(key)) {
    urls.delete(url);
    return null;
  }
  return key;
}
