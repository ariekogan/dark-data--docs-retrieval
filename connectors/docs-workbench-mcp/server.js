#!/usr/bin/env node
/**
 * ADAS Docs Workbench MCP (stdio)
 *
 * Thin connector whose main job is hosting the Docs Workbench UI plugin.
 * Exposes ui.listPlugins / ui.getPlugin per ADAS UI-plugin contract.
 * The UI itself (ui-dist/workbench/index.html) talks directly to
 * dropbox-mcp and docs-index-mcp via the host postMessage bridge.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CONNECTOR_ID = "docs-workbench-mcp";

const PLUGINS = [
  {
    id: `mcp:${CONNECTOR_ID}:workbench`,
    name: "Docs Workbench",
    version: "0.1.0",
    type: "ui",
    description: "Setup wizard (Dropbox connection) and corpus manager for the docs-retrieval solution.",
    render: {
      mode: "iframe",
      iframeUrl: `/ui/workbench/index.html`,
    },
    capabilities: {},
    channels: ["command"],
    commands: [],
  },
];

function ok(p) { return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...p }) }] }; }
function err(m) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: m }) }] }; }

const server = new McpServer({ name: "adas-docs-workbench-mcp", version: "0.1.0" });

server.tool(
  "ui.listPlugins",
  "List UI plugins hosted by this connector.",
  {},
  async () => ok({ plugins: PLUGINS.map(({ id, name, version, description, type }) => ({ id, name, version, description, type })) })
);

server.tool(
  "ui.getPlugin",
  "Get the full manifest for a specific plugin by id.",
  { plugin_id: z.string() },
  async ({ plugin_id }) => {
    const p = PLUGINS.find((x) => x.id === plugin_id);
    if (!p) return err(`Plugin not found: ${plugin_id}`);
    return ok({ plugin: p });
  }
);

server.tool(
  "workbench.health",
  "Diagnostics for the workbench connector.",
  {},
  async () => ok({ service: "docs-workbench-mcp", plugins: PLUGINS.length })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[adas-docs-workbench-mcp v0.1.0] stdio MCP ready. ${PLUGINS.length} plugin(s) hosted.`);
