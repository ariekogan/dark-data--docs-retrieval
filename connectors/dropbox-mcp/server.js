#!/usr/bin/env node
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tokenStore from "./src/tokenStore.js";
import * as dropbox from "./src/dropboxClient.js";
import { DropboxAuthRequired } from "./src/dropboxClient.js";
import { indexFolder } from "./src/indexFolder.js";

const APP_KEY = process.env.DROPBOX_APP_KEY || "";
const APP_SECRET = process.env.DROPBOX_APP_SECRET || "";
const REDIRECT_URI = process.env.DROPBOX_OAUTH_REDIRECT_URI || "";
const TENANT = process.env.ADAS_TENANT || process.env.TENANT || "";
const SHARED_MODE = process.env.DROPBOX_SHARED_MODE === "1";
const SHARED_ACTOR_ID = "_tenant_shared";
const SYSTEM_ACTOR_IDS = new Set(["trigger-runner", "default", "_system_service", "legacy_single_user"]);

function getActor(args) {
  // Shared-mode MVP: a single Dropbox connection serves the entire tenant.
  // Every tool resolves to a fixed actor id; every user hits the same tokens.
  if (SHARED_MODE) return SHARED_ACTOR_ID;
  const id = process.env.ADAS_ACTOR_ID || args?._adas_actor;
  if (!id || SYSTEM_ACTOR_IDS.has(id)) throw new Error(`Dropbox tools require a real authenticated actor — got "${id || "none"}".`);
  return id;
}
function getTenant(args) {
  const t = process.env.ADAS_TENANT || process.env.TENANT || args?._adas_tenant || TENANT;
  if (!t) throw new Error("Dropbox tools require a tenant");
  return t;
}

function ok(p) { return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...p }) }] }; }
function err(m, x = {}) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: m, ...x }) }] }; }
function authRequired(a) { return err("Dropbox not connected — call dropbox.setup", { code: "DROPBOX_AUTH_REQUIRED", actor_id: a }); }

async function handle(args, fn) {
  try { return await fn(getTenant(args), getActor(args)); }
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

const server = new McpServer({ name: "adas-dropbox-mcp", version: "0.1.0" });

server.tool("dropbox.setup", "Start Dropbox OAuth flow. Returns URL for user to grant access.", {}, async (args) =>
  handle(args, async (tenant, actor) => {
    if (!APP_KEY || !REDIRECT_URI) return err("Dropbox OAuth not configured");
    const nonce = crypto.randomUUID();
    const { verifier, challenge } = pkcePair();
    await tokenStore.storeNonce(tenant, nonce, actor, verifier);
    const url = new URL("https://www.dropbox.com/oauth2/authorize");
    url.searchParams.set("client_id", APP_KEY);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("token_access_type", "offline");
    url.searchParams.set("state", `${nonce}:${tenant}`);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "account_info.read files.metadata.read files.content.read files.content.write");
    return ok({ auth_url: url.toString(), message: "Open this URL to connect your Dropbox account" });
  })
);

server.tool("dropbox.status", "Check if this actor has Dropbox connected.", {}, async (args) =>
  handle(args, async (tenant, actor) => {
    const t = await tokenStore.getTokens(tenant, actor);
    if (!t) return ok({ connected: false });
    return ok({ connected: true, account_email: t.account_email, account_id: t.account_id });
  })
);

server.tool("dropbox.disconnect", "Remove Dropbox tokens.", {}, async (args) =>
  handle(args, async (tenant, actor) => { await dropbox.revokeAccess(tenant, actor); return ok({ message: "Disconnected" }); })
);

server.tool("dropbox.list_folder", "List files/folders at path.", { path: z.string().optional(), recursive: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().int().optional() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const r = await dropbox.listFolder(tenant, actor, { path: args.path || "", recursive: args.recursive, cursor: args.cursor, limit: args.limit });
    return ok({ entries: r.entries, cursor: r.cursor, has_more: r.has_more });
  })
);

server.tool("dropbox.search", "Full-text search across Dropbox.", { query: z.string(), path: z.string().optional(), max_results: z.number().int().optional() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const r = await dropbox.search(tenant, actor, { query: args.query, path: args.path || "", max_results: args.max_results || 100 });
    const matches = (r.matches || []).map((m) => m.metadata?.metadata || m.metadata || m);
    return ok({ matches, has_more: r.has_more, cursor: r.cursor });
  })
);

server.tool("dropbox.get_metadata", "Get metadata for a path.", { path: z.string() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const m = await dropbox.getMetadata(tenant, actor, { path: args.path });
    return ok({ metadata: m });
  })
);

server.tool("dropbox.download", "Download file as base64 (<=25MB).", { path: z.string() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const m = await dropbox.getMetadata(tenant, actor, { path: args.path });
    if (m[".tag"] !== "file") return err(`Not a file: ${args.path}`);
    if ((m.size || 0) > 25 * 1024 * 1024) return err("File too large (>25MB); use dropbox.get_temporary_link");
    const { buffer } = await dropbox.download(tenant, actor, { path: args.path });
    return ok({ path: args.path, size: m.size, content_base64: buffer.toString("base64"), content_hash: m.content_hash, rev: m.rev });
  })
);

server.tool("dropbox.get_temporary_link", "Short-lived direct-download URL.", { path: z.string() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const r = await dropbox.getTemporaryLink(tenant, actor, { path: args.path });
    return ok({ link: r.link, metadata: r.metadata });
  })
);

server.tool("dropbox.upload", "Upload file (base64).", { path: z.string(), content_base64: z.string(), mode: z.enum(["add", "overwrite"]).optional(), autorename: z.boolean().optional() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const buf = Buffer.from(args.content_base64, "base64");
    const r = await dropbox.upload(tenant, actor, { path: args.path, content: buf, mode: args.mode || "add", autorename: args.autorename || false });
    return ok({ path: r.path_display, size: r.size, content_hash: r.content_hash, rev: r.rev });
  })
);

server.tool("dropbox.create_folder", "Create folder.", { path: z.string(), autorename: z.boolean().optional() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const r = await dropbox.createFolder(tenant, actor, { path: args.path, autorename: args.autorename || false });
    return ok({ metadata: r.metadata });
  })
);

server.tool("dropbox.index_folder", "Walk Dropbox folder, ingest supported files into docs-index corpus.", { corpus_id: z.string(), path: z.string().optional(), recursive: z.boolean().optional(), use_cursor: z.boolean().optional() }, async (args) =>
  handle(args, async (tenant, actor) => {
    const r = await indexFolder({ tenant, actor, corpus_id: args.corpus_id, path: args.path || "", recursive: args.recursive !== false, use_cursor: args.use_cursor !== false });
    return ok(r);
  })
);

server.tool("dropbox._storeTokens", "Internal: OAuth callback.", { code: z.string(), state: z.string() }, async (args) => {
  try {
    const [nonce, tenant] = String(args.state).split(":");
    if (!nonce || !tenant) return err("Malformed state");
    const nonceDoc = await tokenStore.consumeNonce(tenant, nonce);
    if (!nonceDoc) return err("Nonce not found");
    if (!APP_KEY || !APP_SECRET) return err("DROPBOX_APP_KEY/SECRET not configured");
    const body = new URLSearchParams({ grant_type: "authorization_code", code: args.code, client_id: APP_KEY, client_secret: APP_SECRET, redirect_uri: REDIRECT_URI, code_verifier: nonceDoc.code_verifier });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { const t = await res.text().catch(() => ""); return err(`Token exchange failed: ${res.status}`); }
    const j = await res.json();
    const expiresAt = new Date(Date.now() + (j.expires_in || 14400) * 1000);
    let accountEmail = null, accountId = j.account_id || null;
    try {
      const who = await fetch("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers: { Authorization: `Bearer ${j.access_token}` }, body: "null", signal: AbortSignal.timeout(10000) });
      if (who.ok) { const w = await who.json(); accountEmail = w.email || null; accountId = accountId || w.account_id || null; }
    } catch {}
    await tokenStore.storeTokens(tenant, nonceDoc.actor_id, { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt, scope: j.scope || null, accountEmail, accountId });
    return ok({ actor_id: nonceDoc.actor_id, account_email: accountEmail });
  } catch (e) { return err(e.message); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[adas-dropbox-mcp v0.1.0] stdio MCP ready.`);
