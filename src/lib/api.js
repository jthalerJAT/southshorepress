// Raw-fetch REST helpers for Supabase. We avoid supabase-js's PostgREST
// wrapper because its internal coordination with the auth client was
// hanging indefinitely on `from(...).insert(...)` calls (and likely
// `from(...).select(...)` too). Direct fetch sidesteps the issue.
// Auth-side calls (signIn / signOut / session) still use supabase-js.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

function getAccessToken() {
  try {
    const key = Object.keys(localStorage).find(
      (k) => k.startsWith("sb-") && k.endsWith("-auth-token")
    );
    if (!key) return null;
    const stored = JSON.parse(localStorage.getItem(key) || "{}");
    return (
      stored?.access_token ||
      stored?.currentSession?.access_token ||
      null
    );
  } catch {
    return null;
  }
}

async function restFetch(path, options = {}) {
  const token = getAccessToken();
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const msg =
      (data && (data.message || data.error || data.hint)) ||
      (typeof data === "string" ? data : `HTTP ${resp.status}`);
    throw new Error(msg);
  }
  return data;
}

export async function insertStory(payload) {
  const data = await restFetch("/rest/v1/stories", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  return Array.isArray(data) ? data[0] : data;
}

export async function fetchPublishedStories() {
  const selectClause = [
    "id",
    "headline",
    "subline",
    "byline",
    "body",
    "hero_photo_url",
    "extra_photo_urls",
    "categories",
    "status",
    "published_at",
    "created_at",
    "author:profiles!stories_author_id_fkey(display_name)",
  ].join(",");
  const url =
    `/rest/v1/stories` +
    `?select=${encodeURIComponent(selectClause)}` +
    `&status=eq.published` +
    `&order=published_at.desc`;
  const data = await restFetch(url);
  return Array.isArray(data) ? data : [];
}
