/**
 * Dropbox API HTTP client. Tokens + app config loaded from SQLite (src/storage.js),
 * with env-var fallback during migration. Drops all Mongo + tenant params — the
 * tenant is implicit in DATA_DIR, isolated by Core at filesystem level.
 */

import * as storage from "./storage.js";

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

const ENV_APP_KEY = process.env.DROPBOX_APP_KEY || "";
const ENV_APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const ENV_REDIRECT_URI = process.env.DROPBOX_OAUTH_REDIRECT_URI || "";

function effectiveAppConfig() {
  const db = storage.getAppConfigInternal();
  if (db) return db;
  if (ENV_APP_KEY && ENV_APP_SECRET) {
    return { app_key: ENV_APP_KEY, app_secret: ENV_APP_SECRET, redirect_uri: ENV_REDIRECT_URI };
  }
  return null;
}

export class DropboxAuthRequired extends Error {
  constructor(m = "Dropbox not connected") { super(m); this.code = "DROPBOX_AUTH_REQUIRED"; }
}

async function getValidAccessToken(actorId) {
  const tokens = storage.getTokens(actorId);
  if (!tokens) throw new DropboxAuthRequired();

  const now = Date.now();
  const exp = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (exp - now < 60000) {
    if (!tokens.refresh_token) throw new DropboxAuthRequired("Token expired");
    const cfg = effectiveAppConfig();
    if (!cfg) throw new Error("Dropbox app not configured");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: cfg.app_key,
      client_secret: cfg.app_secret,
    });
    const res = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (res.status === 400 || res.status === 401) {
        storage.deleteTokens(actorId);
        throw new DropboxAuthRequired(`Refresh failed: ${res.status} ${t.slice(0, 100)}`);
      }
      throw new Error(`Refresh failed: ${res.status}`);
    }
    const j = await res.json();
    const newExp = new Date(now + (j.expires_in || 14400) * 1000);
    storage.updateAccessToken(actorId, { accessToken: j.access_token, expiresAt: newExp });
    return j.access_token;
  }
  return tokens.access_token;
}

async function rpc(path, payload, token) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === null || payload === undefined ? "null" : JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`Dropbox ${path} ${res.status}: ${b.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function contentDownload(path, arg, token) {
  const res = await fetch(`${CONTENT}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(arg) },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`Dropbox ${path} ${res.status}: ${b.slice(0, 200)}`); }
  const apiResult = res.headers.get("dropbox-api-result");
  const buffer = Buffer.from(await res.arrayBuffer());
  return { meta: apiResult ? JSON.parse(apiResult) : null, buffer };
}

async function contentUpload(path, arg, body, token) {
  const res = await fetch(`${CONTENT}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(arg), "Content-Type": "application/octet-stream" },
    body,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Dropbox ${path} ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}

export async function listFolder(actorId, { path = "", recursive = false, cursor = null, limit = 2000 } = {}) {
  const t = await getValidAccessToken(actorId);
  if (cursor) return rpc("/2/files/list_folder/continue", { cursor }, t);
  return rpc("/2/files/list_folder", { path, recursive, limit, include_media_info: false, include_deleted: false }, t);
}

export async function search(actorId, { query, path = "", max_results = 100 }) {
  const t = await getValidAccessToken(actorId);
  return rpc("/2/files/search_v2", { query, options: { path, max_results, file_status: "active" } }, t);
}

export async function getMetadata(actorId, { path }) {
  const t = await getValidAccessToken(actorId);
  return rpc("/2/files/get_metadata", { path }, t);
}

export async function download(actorId, { path }) {
  const t = await getValidAccessToken(actorId);
  return contentDownload("/2/files/download", { path }, t);
}

/**
 * Export a file that's not directly downloadable (Dropbox Paper etc.).
 * Uses /2/files/export. `format` must be one of the options in the file's
 * metadata.export_info.export_options (commonly 'html' or 'markdown').
 * Returns { meta, buffer } just like download().
 */
export async function exportFile(actorId, { path, format = "html" }) {
  const t = await getValidAccessToken(actorId);
  return contentDownload("/2/files/export", { path, export_format: format }, t);
}

export async function getTemporaryLink(actorId, { path }) {
  const t = await getValidAccessToken(actorId);
  return rpc("/2/files/get_temporary_link", { path }, t);
}

export async function upload(actorId, { path, content, mode = "add", autorename = false }) {
  const t = await getValidAccessToken(actorId);
  return contentUpload("/2/files/upload", { path, mode, autorename, mute: true, strict_conflict: false }, content, t);
}

export async function createFolder(actorId, { path, autorename = false }) {
  const t = await getValidAccessToken(actorId);
  return rpc("/2/files/create_folder_v2", { path, autorename }, t);
}

export async function revokeAccess(actorId) {
  try { const t = await getValidAccessToken(actorId); await rpc("/2/auth/token/revoke", null, t); } catch {}
  storage.deleteTokens(actorId);
}
