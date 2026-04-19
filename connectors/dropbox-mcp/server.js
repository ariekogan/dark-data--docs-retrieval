#!/usr/bin/env node
/**
 * ADAS Dropbox MCP (stdio, solution connector).
 *
 * Storage is SQLite (via node:sqlite) rooted at DATA_DIR —
 * per-tenant filesystem isolation provided by A-Team Core. Three tables:
 *   app_config     — org-wide Dropbox app creds (set via dropbox.app.set_config)
 *   tokens         — per-actor OAuth tokens (or _tenant_shared in shared mode)
 *   oauth_nonces   — short-lived PKCE state
 *
 * Credentials source-of-truth order:
 *   1) SQLite app_config (set by workbench UI via dropbox.app.set_config)
 *   2) Env vars (DROPBOX_APP_KEY etc) — legacy fallback for MVP
 *
 * Once UI-set credentials are verified working, env vars can be dropped.
 */

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as storage from "./src/storage.js";
import * as dropbox from "./src/dropboxClient.js";
import { DropboxAuthRequired } from "./src/dropboxClient.js";
import { indexFolder } from "./src/indexFolder.js";

const SHARED_MODE = process.env.DROPBOX_SHARED_MODE === "1";
const SHARED_ACTOR_ID = "_tenant_shared";
const SYSTEM_ACTOR_IDS = new Set(["trigger-runner", "default", "_system_service", "legacy_single_user"]);

// Env fallback — used only when app_config hasn't been set in SQLite yet.
const ENV_APP_KEY = process.env.DROPBOX_APP_KEY || "";
const ENV_APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const ENV_REDIRECT_URI = process.env.DROPBOX_OAUTH_REDIRECT_URI || "";

/** Get the effective app config — SQLite first, env fallback. */
function effectiveAppConfig() {
  const db = storage.getAppConfigInternal();
  if (db) return { ...db, source: "sqlite" };
  if (ENV_APP_KEY && ENV_APP_SECRET) {
    return {
      app_key: ENV_APP_KEY,
      app_secret: ENV_APP_SECRET,
      redirect_uri: ENV_REDIRECT_URI,
      source: "env",
    };
  }
  return null;
}

function getActor(args) {
  if (SHARED_MODE) return SHARED_ACTOR_ID;
  const id = process.env.ADAS_ACTOR_ID || args?._adas_actor;
  if (!id || SYSTEM_ACTOR_IDS.has(id)) {
    throw new Error(`Dropbox tools require a real authenticated actor — got "${id || "none"}".`);
  }
  return id;
}

function ok(p) { return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...p }) }] }; }
function err(m, x = {}) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: m, ...x }) }] }; }
function authRequired(a) { return err("Dropbox not connected — call dropbox.setup", { code: "DROPBOX_AUTH_REQUIRED", actor_id: a }); }

async function handle(args, fn) {
  try { return await fn(getActor(args)); }
  catch (e) {
    if (e instanceof DropboxAuthRequired) return authRequired(args?._adas_actor);
    return err(e.message);
  }
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const server = new McpServer({ name: "adas-dropbox-mcp", version: "0.2.0" });

// ───────── App config tools (UI-managed credentials) ─────────

server.tool(
  "dropbox.app.get_config",
  "Check whether Dropbox app credentials are configured. Returns { configured, app_key_preview, redirect_uri } — never returns the secret.",
  {},
  async () => {
    const pub = storage.getAppConfigPublic();
    // Also reflect env-fallback state for the UI
    if (!pub.configured && ENV_APP_KEY && ENV_APP_SECRET) {
      return ok({
        configured: true,
        source: "env",
        app_key_preview: ENV_APP_KEY.slice(0, 4) + "…" + ENV_APP_KEY.slice(-3),
        redirect_uri: ENV_REDIRECT_URI,
      });
    }
    return ok({ ...pub, source: pub.configured ? "sqlite" : "none" });
  }
);

server.tool(
  "dropbox.app.set_config",
  "Store the Dropbox app credentials (app_key + app_secret + redirect_uri) in the connector's SQLite. Once set, takes precedence over env vars. Use from the workbench setup UI.",
  {
    app_key: z.string().min(1),
    app_secret: z.string().min(1),
    redirect_uri: z.string().optional(),
  },
  async ({ app_key, app_secret, redirect_uri }) => {
    try {
      const result = storage.setAppConfig({
        app_key,
        app_secret,
        redirect_uri: redirect_uri || "https://api.ateam-ai.com/api/integrations/dropbox/callback",
      });
      return ok({ ...result, source: "sqlite" });
    } catch (e) {
      return err(e.message);
    }
  }
);

server.tool(
  "dropbox.app.clear_config",
  "Delete the stored Dropbox app credentials (does not affect per-user OAuth tokens).",
  {},
  async () => {
    storage.clearAppConfig();
    return ok({ configured: false });
  }
);

// ───────── User flow ─────────

server.tool(
  "dropbox.setup",
  "Start Dropbox OAuth flow. Returns a URL for the user to grant access.",
  {},
  async (args) =>
    handle(args, async (actor) => {
      const cfg = effectiveAppConfig();
      if (!cfg || !cfg.app_key || !cfg.redirect_uri) {
        return err("Dropbox app not configured — set it via the workbench UI (dropbox.app.set_config).", { code: "APP_NOT_CONFIGURED" });
      }
      const nonce = crypto.randomUUID();
      const { verifier, challenge } = pkcePair();
      storage.storeNonce(nonce, actor, verifier);
      const url = new URL("https://www.dropbox.com/oauth2/authorize");
      url.searchParams.set("client_id", cfg.app_key);
      url.searchParams.set("redirect_uri", cfg.redirect_uri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("token_access_type", "offline");
      url.searchParams.set("state", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("scope", "account_info.read files.metadata.read files.content.read files.content.write");
      return ok({ auth_url: url.toString(), message: "Open this URL to connect your Dropbox account" });
    })
);

server.tool("dropbox.status", "Check if this actor has Dropbox connected.", {}, async (args) =>
  handle(args, async (actor) => {
    const t = storage.getTokens(actor);
    if (!t) return ok({ connected: false });
    return ok({ connected: true, account_email: t.account_email, account_id: t.account_id });
  })
);

server.tool("dropbox.disconnect", "Remove Dropbox tokens.", {}, async (args) =>
  handle(args, async (actor) => { await dropbox.revokeAccess(actor); return ok({ message: "Disconnected" }); })
);

// ───────── Browse / read ─────────

server.tool("dropbox.list_folder", "List files/folders at path.",
  { path: z.string().optional(), recursive: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().int().optional() },
  async (args) => handle(args, async (actor) => {
    const r = await dropbox.listFolder(actor, { path: args.path || "", recursive: args.recursive, cursor: args.cursor, limit: args.limit });
    return ok({ entries: r.entries, cursor: r.cursor, has_more: r.has_more });
  })
);

server.tool("dropbox.search", "Full-text search across Dropbox.",
  { query: z.string(), path: z.string().optional(), max_results: z.number().int().optional() },
  async (args) => handle(args, async (actor) => {
    const r = await dropbox.search(actor, { query: args.query, path: args.path || "", max_results: args.max_results || 100 });
    const matches = (r.matches || []).map((m) => m.metadata?.metadata || m.metadata || m);
    return ok({ matches, has_more: r.has_more, cursor: r.cursor });
  })
);

server.tool("dropbox.get_metadata", "Get metadata for a path.", { path: z.string() }, async (args) =>
  handle(args, async (actor) => {
    const m = await dropbox.getMetadata(actor, { path: args.path });
    return ok({ metadata: m });
  })
);

server.tool("dropbox.download", "Download file as base64 (<=25MB).", { path: z.string() }, async (args) =>
  handle(args, async (actor) => {
    const m = await dropbox.getMetadata(actor, { path: args.path });
    if (m[".tag"] !== "file") return err(`Not a file: ${args.path}`);
    if ((m.size || 0) > 25 * 1024 * 1024) return err("File too large (>25MB); use dropbox.get_temporary_link");
    const { buffer } = await dropbox.download(actor, { path: args.path });
    return ok({ path: args.path, size: m.size, content_base64: buffer.toString("base64"), content_hash: m.content_hash, rev: m.rev });
  })
);

server.tool("dropbox.get_temporary_link", "Short-lived direct-download URL.", { path: z.string() }, async (args) =>
  handle(args, async (actor) => {
    const r = await dropbox.getTemporaryLink(actor, { path: args.path });
    return ok({ link: r.link, metadata: r.metadata });
  })
);

// ───────── Write ─────────

server.tool("dropbox.upload", "Upload file (base64).",
  { path: z.string(), content_base64: z.string(), mode: z.enum(["add", "overwrite"]).optional(), autorename: z.boolean().optional() },
  async (args) => handle(args, async (actor) => {
    const buf = Buffer.from(args.content_base64, "base64");
    const r = await dropbox.upload(actor, { path: args.path, content: buf, mode: args.mode || "add", autorename: args.autorename || false });
    return ok({ path: r.path_display, size: r.size, content_hash: r.content_hash, rev: r.rev });
  })
);

server.tool("dropbox.create_folder", "Create folder.",
  { path: z.string(), autorename: z.boolean().optional() },
  async (args) => handle(args, async (actor) => {
    const r = await dropbox.createFolder(actor, { path: args.path, autorename: args.autorename || false });
    return ok({ metadata: r.metadata });
  })
);

// ───────── Ingest ─────────

server.tool("dropbox.index_folder", "Walk Dropbox folder, ingest supported files into docs-index corpus.",
  { corpus_id: z.string(), path: z.string().optional(), recursive: z.boolean().optional(), use_cursor: z.boolean().optional() },
  async (args) => handle(args, async (actor) => {
    const r = await indexFolder({ actor, corpus_id: args.corpus_id, path: args.path || "", recursive: args.recursive !== false, use_cursor: args.use_cursor !== false });
    return ok(r);
  })
);

// ───────── Internal: OAuth callback (invoked by Core's /api/integrations/dropbox/callback) ─────────

server.tool("dropbox._storeTokens", "Internal: exchange OAuth code and store tokens.",
  { code: z.string(), state: z.string() },
  async (args) => {
    try {
      const nonceDoc = storage.consumeNonce(String(args.state));
      if (!nonceDoc) return err("Nonce not found or expired");
      const cfg = effectiveAppConfig();
      if (!cfg) return err("Dropbox app not configured");

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        client_id: cfg.app_key,
        client_secret: cfg.app_secret,
        redirect_uri: cfg.redirect_uri,
        code_verifier: nonceDoc.code_verifier,
      });
      const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { const t = await res.text().catch(() => ""); return err(`Token exchange failed: ${res.status} ${t.slice(0, 200)}`); }
      const j = await res.json();
      const expiresAt = new Date(Date.now() + (j.expires_in || 14400) * 1000);

      let accountEmail = null, accountId = j.account_id || null;
      try {
        const who = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
          method: "POST",
          headers: { Authorization: `Bearer ${j.access_token}` },
          body: "null",
          signal: AbortSignal.timeout(10000),
        });
        if (who.ok) {
          const w = await who.json();
          accountEmail = w.email || null;
          accountId = accountId || w.account_id || null;
        }
      } catch {}

      storage.storeTokens(nonceDoc.actor_id, {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt,
        scope: j.scope || null,
        accountEmail,
        accountId,
      });
      return ok({ actor_id: nonceDoc.actor_id, account_email: accountEmail });
    } catch (e) {
      return err(e.message);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[adas-dropbox-mcp v0.2.0] stdio MCP ready. SQLite at ${process.env.DATA_DIR || "./.data"}. shared_mode=${SHARED_MODE}`);
