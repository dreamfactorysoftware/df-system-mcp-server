"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVER_VERSION = exports.SERVER_NAME = void 0;
exports.resolveDisabledTools = resolveDisabledTools;
exports.buildMcpServer = buildMcpServer;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const tools_1 = require("./tools");
exports.SERVER_NAME = "df-system-mcp";
exports.SERVER_VERSION = "0.5.0";
let warnedCustomTools = false;
/**
 * Normalise the `disabled_tools` value from a DreamFactory service config into
 * a Set of known tool names. Accepts an array of strings (or a JSON string of
 * one, or a comma-separated string) — unknown names are dropped silently.
 */
function resolveDisabledTools(config) {
    const out = new Set();
    if (!config)
        return out;
    let raw = config.disabled_tools;
    if (typeof raw === "string") {
        const str = raw;
        try {
            raw = JSON.parse(str);
        }
        catch {
            raw = str.split(",");
        }
    }
    if (!Array.isArray(raw))
        return out;
    const known = new Set(tools_1.TOOL_NAMES);
    for (const v of raw) {
        if (typeof v === "string") {
            const name = v.trim();
            if (known.has(name))
                out.add(name);
        }
    }
    return out;
}
/**
 * Build a fresh McpServer with every control-plane tool registered, minus any
 * listed in the service config's `disabled_tools`.
 * Each MCP HTTP session gets its own instance so handlers can pull the right
 * sessionId from `extra.sessionId` and look up the bound DreamFactory token.
 */
function buildMcpServer(config) {
    const server = new mcp_js_1.McpServer({
        name: exports.SERVER_NAME,
        version: exports.SERVER_VERSION,
        capabilities: {
            tools: {},
            logging: {},
        },
    });
    if (config && Array.isArray(config.custom_tools) && config.custom_tools.length > 0 && !warnedCustomTools) {
        warnedCustomTools = true;
        console.debug("[df-system-mcp] custom_tools present in service config; ignored by the System API MCP server");
    }
    (0, tools_1.registerTools)(server, { disabled: resolveDisabledTools(config) });
    return server;
}
//# sourceMappingURL=server.js.map