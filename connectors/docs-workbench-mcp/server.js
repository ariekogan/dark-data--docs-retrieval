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

const WORKBENCH_MANIFEST = {
  id: `mcp:${CONNECTOR_ID}:workbench`,
  name: "Docs Workbench",
  version: "0.1.0",
  type: "ui",
  description: "Dropbox setup wizard + corpus manager for the docs-retrieval solution.",
  render: {
    mode: "adaptive",
    iframeUrl: "/ui/workbench/index.html",
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

// Spec: { plugins: [...] } with FULL manifests.
server.tool(
  "ui.listPlugins",
  "List UI plugins hosted by this connector. Returns full manifests.",
  {},
  async () => ok({ plugins: PLUGINS })
);

// Spec: return manifest DIRECTLY, not wrapped in { plugin: ... }.
server.tool(
  "ui.getPlugin",
  "Return the full manifest for a specific plugin by id.",
  { plugin_id: z.string() },
  async ({ plugin_id }) => {
    const m = PLUGINS.find((x) => x.id === plugin_id);
    if (!m) return err(`Plugin not found: ${plugin_id}`);
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
