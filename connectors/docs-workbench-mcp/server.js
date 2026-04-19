#!/usr/bin/env node
/**
 * ADAS Docs Workbench MCP (stdio)
 *
 * Hosts the Docs Workbench UI plugin (Dropbox setup wizard + corpus manager).
 * Implements the ui-capable connector contract per mobile-pa working pattern
 * and GET /spec/examples/connector-ui:
 *
 *   ui.listPlugins → { plugins: [<FULL manifests with render.iframeUrl>] }
 *   ui.getPlugin   → returns the manifest object DIRECTLY (NOT wrapped in { plugin }).
 *
 * The manifest itself mirrors mobile-pa's whatsapp-setup shape:
 *   - render.mode: "adaptive"   (iframe on web, optional native on mobile)
 *   - render.iframeUrl: "/ui/<plugin-name>/index.html"  (no version in path)
 *   - NO top-level iframeUrl    (spec wrong_example[2])
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CONNECTOR_ID = "docs-workbench-mcp";

// Per fleet-mcp reference pattern (GET /spec/examples + public solutions):
// ui.getPlugin returns the manifest with a SHORT id. A-Team adds the
// mcp:<connector-id>: prefix externally — the solution.json uses the FQN.
const WORKBENCH_MANIFEST = {
  id: "workbench",
  name: "Docs Workbench",
  version: "0.1.0",
  description: "Dropbox setup wizard + corpus manager for the docs-retrieval solution.",
  render: {
    mode: "adaptive",
    iframeUrl: "/ui/workbench/index.html",
    reactNative: { component: "workbench" },
  },
  capabilities: {},
  channels: ["command"],
  commands: [],
};

const PLUGINS = [WORKBENCH_MANIFEST];

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
function err(m) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: m }) }] };
}

const server = new McpServer({ name: "adas-docs-workbench-mcp", version: "0.1.0" });

// Per fleet-mcp reference: listPlugins returns a minimal summary per plugin.
server.tool(
  "ui.listPlugins",
  "List UI plugins hosted by this connector.",
  {},
  async () => ok({
    plugins: PLUGINS.map(({ id, name, version, description }) => ({ id, name, version, description })),
  })
);

// Per personal-assistant-ui-mcp reference: argument is `id` (NOT `plugin_id`).
// Return the FULL manifest DIRECTLY (no { plugin: ... } wrapper).
// Accept short id OR the FQN (mcp:<connector>:<short-id>) for compat.
server.tool(
  "ui.getPlugin",
  "Return the full manifest for a specific plugin by id.",
  {
    id: z.string().optional().describe("Plugin id (short form, e.g. 'workbench')"),
    plugin_id: z.string().optional().describe("Legacy alias for id"),
  },
  async (args) => {
    const raw = args?.id || args?.plugin_id;
    if (!raw) return err("id required");
    const shortId = raw.startsWith(`mcp:${CONNECTOR_ID}:`)
      ? raw.slice(`mcp:${CONNECTOR_ID}:`.length)
      : raw;
    const m = PLUGINS.find((x) => x.id === shortId || x.id === raw);
    if (!m) return err(`Plugin not found: ${raw}`);
    return ok(m);
  }
);

server.tool(
  "workbench.health",
  "Diagnostics for the workbench connector.",
  {},
  async () => ok({ service: CONNECTOR_ID, plugins: PLUGINS.length, version: WORKBENCH_MANIFEST.version })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[adas-docs-workbench-mcp v${WORKBENCH_MANIFEST.version}] stdio MCP ready. ${PLUGINS.length} plugin(s) hosted.`);
