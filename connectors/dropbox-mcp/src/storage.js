/**
 * Dropbox storage — SQLite (node:sqlite DatabaseSync).
 *
 * Tenant-scoped via DATA_DIR (set by Core: /tenants/<tenant>/connector-data/<connector-id>/).
 * Three tables:
 *   app_config     — single row, org-wide Dropbox app credentials (app_key, app_secret, redirect_uri)
 *   tokens         — per-actor OAuth tokens (access + refresh + expiry + account info)
 *   oauth_nonces   — short-lived PKCE state (nonce + code_verifier), cleaned on read / periodically
 *
 * In shared-mode (DROPBOX_SHARED_MODE=1), all token rows use actor_id="_tenant_shared".
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "dropbox.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (
    key           TEXT PRIMARY KEY,
    app_key       TEXT,
    app_secret    TEXT,
    redirect_uri  TEXT,
    updated_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS tokens (
    actor_id       TEXT PRIMARY KEY,
    account_email  TEXT,
    account_id     TEXT,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT,
    expires_at     TEXT,
    scope          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_nonces (
    nonce          TEXT PRIMARY KEY,
    actor_id       TEXT NOT NULL,
    code_verifier  TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
`);

const nowISO = () => new Date().toISOString();

// ────────── App config (org-wide) ──────────

/**
 * Returns { configured, app_key_preview, redirect_uri, updated_at } — NEVER returns the secret.
 * Used by the UI to show status and by _storeTokens/setup to check if set.
 */
export function getAppConfigPublic() {
  const row = db.prepare("SELECT * FROM app_config WHERE key = 'default'").get();
  if (!row || !row.app_key) return { configured: false };
  return {
    configured: true,
    app_key_preview: row.app_key.slice(0, 4) + "…" + row.app_key.slice(-3),
    redirect_uri: row.redirect_uri || "",
    updated_at: row.updated_at,
  };
}

/** Internal: returns the FULL config including secret. Only for OAuth flows.
 *  Relaxed: returns whatever is in the row (possibly partial) — the caller
 *  merges with env to fill missing fields. */
export function getAppConfigInternal() {
  const row = db.prepare("SELECT * FROM app_config WHERE key = 'default'").get();
  if (!row) return null;
  return {
    app_key: row.app_key || "",
    app_secret: row.app_secret || "",
    redirect_uri: row.redirect_uri || "",
  };
}

/** DEBUG: raw row inspection (secret masked). For diagnostics only. */
export function debugRawRow() {
  const row = db.prepare("SELECT * FROM app_config WHERE key = 'default'").get();
  if (!row) return { exists: false };
  return {
    exists: true,
    app_key_len: (row.app_key || "").length,
    app_key_preview: row.app_key ? row.app_key.slice(0, 4) + "…" + row.app_key.slice(-3) : "",
    app_secret_len: (row.app_secret || "").length,
    has_app_secret: Boolean(row.app_secret),
    redirect_uri: row.redirect_uri || "",
    redirect_uri_len: (row.redirect_uri || "").length,
    updated_at: row.updated_at,
  };
}

export function setAppConfig({ app_key, app_secret, redirect_uri }) {
  if (!app_key || !app_secret) throw new Error("app_key and app_secret required");
  db.prepare(`
    INSERT INTO app_config(key, app_key, app_secret, redirect_uri, updated_at)
    VALUES ('default', ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      app_key      = excluded.app_key,
      app_secret   = excluded.app_secret,
      redirect_uri = excluded.redirect_uri,
      updated_at   = excluded.updated_at
  `).run(app_key, app_secret, redirect_uri || "", nowISO());
  return getAppConfigPublic();
}

export function clearAppConfig() {
  db.prepare("DELETE FROM app_config WHERE key = 'default'").run();
  return { configured: false };
}

// ────────── OAuth tokens (per-actor, or _tenant_shared in shared mode) ──────────

export function storeTokens(actorId, { accountEmail, accessToken, refreshToken, expiresAt, scope, accountId }) {
  db.prepare(`
    INSERT INTO tokens(actor_id, account_email, account_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(actor_id) DO UPDATE SET
      account_email = excluded.account_email,
      account_id    = excluded.account_id,
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
      expires_at    = excluded.expires_at,
      scope         = excluded.scope,
      updated_at    = excluded.updated_at
  `).run(
    actorId,
    accountEmail || null,
    accountId || null,
    accessToken,
    refreshToken || null,
    expiresAt ? new Date(expiresAt).toISOString() : null,
    scope || null,
    nowISO(),
    nowISO()
  );
}

export function updateAccessToken(actorId, { accessToken, expiresAt }) {
  db.prepare(`
    UPDATE tokens SET access_token = ?, expires_at = ?, updated_at = ?
    WHERE actor_id = ?
  `).run(accessToken, expiresAt ? new Date(expiresAt).toISOString() : null, nowISO(), actorId);
}

export function getTokens(actorId) {
  return db.prepare("SELECT * FROM tokens WHERE actor_id = ?").get(actorId) || null;
}

export function deleteTokens(actorId) {
  db.prepare("DELETE FROM tokens WHERE actor_id = ?").run(actorId);
}

// ────────── OAuth nonces (PKCE state, 10-min TTL) ──────────

const NONCE_TTL_SECONDS = 600;

export function storeNonce(nonce, actorId, codeVerifier) {
  db.prepare(`
    INSERT OR REPLACE INTO oauth_nonces(nonce, actor_id, code_verifier, created_at)
    VALUES (?, ?, ?, ?)
  `).run(nonce, actorId, codeVerifier, nowISO());
  // Opportunistic cleanup: drop expired nonces.
  const cutoff = new Date(Date.now() - NONCE_TTL_SECONDS * 1000).toISOString();
  db.prepare("DELETE FROM oauth_nonces WHERE created_at < ?").run(cutoff);
}

export function consumeNonce(nonce) {
  const row = db.prepare("SELECT * FROM oauth_nonces WHERE nonce = ?").get(nonce);
  if (!row) return null;
  db.prepare("DELETE FROM oauth_nonces WHERE nonce = ?").run(nonce);
  // Expired check
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > NONCE_TTL_SECONDS * 1000) return null;
  return row;
}
