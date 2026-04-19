import * as tokenStore from "./tokenStore.js";
const APP_KEY = process.env.DROPBOX_APP_KEY || "";
const APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

export class DropboxAuthRequired extends Error { constructor(m = "Dropbox not connected") { super(m); this.code = "DROPBOX_AUTH_REQUIRED"; } }

async function getValidAccessToken(tenant, actorId) {
  const tokens = await tokenStore.getTokens(tenant, actorId);
  if (!tokens) throw new DropboxAuthRequired();
  const now = Date.now();
  const exp = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (exp - now < 60000) {
    if (!tokens.refresh_token) throw new DropboxAuthRequired("Token expired");
    if (!APP_KEY || !APP_SECRET) throw new Error("KEY/SECRET not configured");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: APP_KEY, client_secret: APP_SECRET });
    const res = await fetch(`${API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { const t = await res.text().catch(() => ""); if (res.status === 400 || res.status === 401) { await tokenStore.deleteTokens(tenant, actorId); throw new DropboxAuthRequired(`Refresh failed: ${res.status}`); } throw new Error(`Refresh failed: ${res.status}`); }
    const j = await res.json();
    const newExp = new Date(now + (j.expires_in || 14400) * 1000);
    await tokenStore.updateAccessToken(tenant, actorId, { accessToken: j.access_token, expiresAt: newExp });
    return j.access_token;
  }
  return tokens.access_token;
}
async function rpc(path, payload, token) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: payload === null || payload === undefined ? "null" : JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`Dropbox ${path} ${res.status}: ${b.slice(0, 300)}`); }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
async function contentDownload(path, arg, token) {
  const res = await fetch(`${CONTENT}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(arg) }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`Dropbox ${path} ${res.status}`); }
  const apiResult = res.headers.get("dropbox-api-result");
  const buffer = Buffer.from(await res.arrayBuffer());
  return { meta: apiResult ? JSON.parse(apiResult) : null, buffer };
}
async function contentUpload(path, arg, body, token) {
  const res = await fetch(`${CONTENT}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(arg), "Content-Type": "application/octet-stream" }, body, signal: AbortSignal.timeout(120000) });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Dropbox ${path} ${res.status}`); }
  return res.json();
}

export async function listFolder(tenant, actorId, { path = "", recursive = false, cursor = null, limit = 2000 } = {}) { const t = await getValidAccessToken(tenant, actorId); if (cursor) return rpc("/2/files/list_folder/continue", { cursor }, t); return rpc("/2/files/list_folder", { path, recursive, limit, include_media_info: false, include_deleted: false }, t); }
export async function search(tenant, actorId, { query, path = "", max_results = 100 }) { const t = await getValidAccessToken(tenant, actorId); return rpc("/2/files/search_v2", { query, options: { path, max_results, file_status: "active" } }, t); }
export async function getMetadata(tenant, actorId, { path }) { const t = await getValidAccessToken(tenant, actorId); return rpc("/2/files/get_metadata", { path }, t); }
export async function download(tenant, actorId, { path }) { const t = await getValidAccessToken(tenant, actorId); return contentDownload("/2/files/download", { path }, t); }
export async function getTemporaryLink(tenant, actorId, { path }) { const t = await getValidAccessToken(tenant, actorId); return rpc("/2/files/get_temporary_link", { path }, t); }
export async function upload(tenant, actorId, { path, content, mode = "add", autorename = false }) { const t = await getValidAccessToken(tenant, actorId); return contentUpload("/2/files/upload", { path, mode, autorename, mute: true, strict_conflict: false }, content, t); }
export async function createFolder(tenant, actorId, { path, autorename = false }) { const t = await getValidAccessToken(tenant, actorId); return rpc("/2/files/create_folder_v2", { path, autorename }, t); }
export async function revokeAccess(tenant, actorId) { try { const t = await getValidAccessToken(tenant, actorId); await rpc("/2/auth/token/revoke", null, t); } catch {} await tokenStore.deleteTokens(tenant, actorId); }
