"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineTool = defineTool;
/**
 * Register a tool unless its name is in `opts.disabled`.
 * Thin wrapper over `server.tool(name, description, schema, handler)` so the
 * per-service `disabled_tools` config can be honoured without touching every
 * tool body. Returns true when the tool was registered.
 */
function defineTool(server, opts, name, description, schema, handler) {
    if (opts?.disabled?.has(name))
        return false;
    server.tool(name, description, schema, handler);
    return true;
}
//# sourceMappingURL=define.js.map