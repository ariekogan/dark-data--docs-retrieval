import * as dropbox from "./dropboxClient.js";

const DOCS_INDEX_URL = process.env.DOCS_INDEX_URL || "http://docs-index-mcp:7311";
const TENANT_HEADER = process.env.ADAS_TENANT || process.env.TENANT || "";

const SUPPORTED_EXTS = new Set([".md",".markdown",".txt",".html",".htm",".pdf",".docx",".csv",".json",".xml",".js",".ts",".tsx",".jsx",".py",".go",".java",".rb",".rs",".c",".cpp",".h",".sh",".yaml",".yml",".toml"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function hasSupportedExt(p) {
  const lower = p.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTS.has(lower.slice(dot));
}

class DocsIndexClient {
  constructor({ url, actor }) { this.url = url; this.actor = actor; this.sessionId = null; this.nextId = 1; }
  async init() {
    await this._raw({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dropbox-mcp", version: "0.2.0" } } });
    await this._raw({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }
  async callTool(name, args) {
    const res = await this._raw({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: { ...args, _adas_actor: this.actor } } });
    if (res?.error) throw new Error(`${name}: ${res.error.message || JSON.stringify(res.error)}`);
    const text = res?.result?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  async _raw(body) {
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
    if (TENANT_HEADER) headers["X-ADAS-TENANT"] = TENANT_HEADER;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(`${this.url}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const sid = res.headers.get("mcp-session-id");
    if (sid && !this.sessionId) this.sessionId = sid;
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`docs-index-mcp ${res.status}: ${t.slice(0, 200)}`); }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1].slice(6)); } catch { return null; }
  }
}

export async function indexFolder({ actor, corpus_id, path, recursive = true, use_cursor = true }) {
  // Dropbox API requires empty string for root, not "/" — normalize.
  if (path === "/" || path == null) path = "";
  // Also strip trailing slash from subfolder paths ("/foo/" → "/foo")
  else if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");

  const client = new DocsIndexClient({ url: DOCS_INDEX_URL, actor });
  await client.init();

  let cursor = null;
  if (use_cursor) {
    const s = await client.callTool("docs.sync.getCursor", { corpus_id });
    cursor = s?.state?.last_cursor || null;
  }

  let indexed = 0, skipped = 0, failed = 0, walked = 0;
  const errors = [];
  let hasMore = true;

  while (hasMore) {
    const page = cursor
      ? await dropbox.listFolder(actor, { cursor })
      : await dropbox.listFolder(actor, { path, recursive });
    cursor = page.cursor;
    hasMore = Boolean(page.has_more);

    for (const entry of page.entries || []) {
      walked += 1;
      if (entry[".tag"] === "deleted") {
        try {
          await client.callTool("docs.ingest.markDeleted", {
            corpus_id,
            source_ids: [entry.path_lower || entry.path_display],
          });
        } catch (e) { errors.push({ path: entry.path_display, error: e.message }); }
        continue;
      }
      if (entry[".tag"] !== "file") continue;
      if (!hasSupportedExt(entry.path_lower || "")) { skipped += 1; continue; }
      if ((entry.size || 0) > MAX_FILE_BYTES) { skipped += 1; continue; }

      try {
        const { buffer } = await dropbox.download(actor, { path: entry.path_lower });
        const content_base64 = buffer.toString("base64");
        const result = await client.callTool("docs.ingest.file", {
          corpus_id,
          source_id: entry.path_lower,
          source_rev: entry.content_hash || entry.rev,
          path: entry.path_display,
          mime: guessMime(entry.path_lower),
          content_base64,
        });
        if (result?.skipped) skipped += 1; else indexed += 1;
      } catch (e) {
        failed += 1;
        errors.push({ path: entry.path_display, error: e.message });
      }
    }
  }

  if (use_cursor && cursor) {
    await client.callTool("docs.sync.setCursor", { corpus_id, cursor, incremental: true });
  }

  return { walked, indexed, skipped, failed, errors: errors.slice(0, 50) };
}

function guessMime(p) {
  const lower = (p || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = lower.slice(dot);
  const map = {
    ".md": "text/markdown", ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html", ".htm": "text/html",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  };
  return map[ext];
}
