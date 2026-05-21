// Raw-fetch helpers for Supabase REST + Auth. We bypass supabase-js
// entirely because both its PostgREST and Auth clients have hung in
// production — the PostgREST builder never fires its fetch, and the
// Auth client deadlocks on internal navigator.locks coordination
// (even with the no-op lock workaround, expired-token refresh hangs).
//
// Three endpoints handle everything we need:
//   POST /auth/v1/token?grant_type=password    -> sign in
//   POST /auth/v1/token?grant_type=refresh     -> refresh token
//   POST /auth/v1/logout                       -> invalidate (best-effort)
//   GET/POST/PATCH /rest/v1/<table>            -> data calls

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PROJECT_REF = (SUPABASE_URL || "").match(/\/\/([^.]+)\./)?.[1] || "";
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

// ── Session storage ────────────────────────────────────────────────────────
function getStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStoredSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (err) {
    console.warn("Failed to persist session:", err);
  }
}

export function clearStoredSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    // Also clear any sibling supabase keys left over from prior client versions.
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* noop */ }
}

function sessionFromTokenResponse(data) {
  const expiresIn = data.expires_in || 3600;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    expires_in: expiresIn,
    token_type: data.token_type || "bearer",
    user: data.user || null,
  };
}

function isExpired(session) {
  if (!session?.expires_at) return true;
  // Treat as expired 30s before actual expiry to avoid a race.
  return Date.now() / 1000 >= session.expires_at - 30;
}

// ── Auth ───────────────────────────────────────────────────────────────────
async function authFetch(path, body) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const msg =
      data?.error_description || data?.msg || data?.message ||
      `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function signInWithPassword(email, password) {
  const data = await authFetch("token?grant_type=password", { email, password });
  const session = sessionFromTokenResponse(data);
  setStoredSession(session);
  return session;
}

async function refreshSession(refreshToken) {
  const data = await authFetch("token?grant_type=refresh_token", {
    refresh_token: refreshToken,
  });
  const session = sessionFromTokenResponse(data);
  setStoredSession(session);
  return session;
}

export async function getCurrentSession() {
  let session = getStoredSession();
  if (!session) return null;
  if (!isExpired(session)) return session;
  if (!session.refresh_token) {
    clearStoredSession();
    return null;
  }
  try {
    return await refreshSession(session.refresh_token);
  } catch (err) {
    console.warn("Session refresh failed; clearing:", err.message);
    clearStoredSession();
    return null;
  }
}

export async function signOut() {
  // Clear local first so the UI updates instantly.
  const session = getStoredSession();
  clearStoredSession();
  // Best-effort server-side invalidate; failures don't matter.
  if (session?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
    } catch { /* noop */ }
  }
}

// ── REST data calls ───────────────────────────────────────────────────────
async function restFetch(path, { authed = true, ...options } = {}) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (authed) {
    const session = await getCurrentSession();
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }
  }
  const resp = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
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
    "id", "headline", "subline", "byline", "body", "hero_photo_url",
    "extra_photo_urls", "categories", "status", "published_at", "created_at",
    "author:profiles!stories_author_id_fkey(display_name)",
  ].join(",");
  const url =
    `/rest/v1/stories` +
    `?select=${encodeURIComponent(selectClause)}` +
    `&status=eq.published` +
    `&order=published_at.desc`;
  // Anonymous read — published stories are public per RLS, no need for a JWT
  // (and stale ones would 401).
  const data = await restFetch(url, { authed: false });
  return Array.isArray(data) ? data : [];
}

export async function fetchProfileById(userId) {
  const data = await restFetch(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}` +
      `&select=id,email,display_name,role&limit=1`
  );
  const arr = Array.isArray(data) ? data : [data];
  return arr[0] || null;
}
