import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";

/**
 * Generic escape hatch: lets the LLM hit any DreamFactory system/* or user/* endpoint
 * that isn't covered by a dedicated tool above. Defense-in-depth path restriction —
 * the real authorisation gate is server-side RBAC on the session token.
 */
export function registerGenericTools(server: McpServer, opts?: RegisterToolOptions): void {
  defineTool(
    server,
    opts,
    "call_system_api",
    "ESCAPE HATCH — call any DreamFactory system/* or user/* endpoint that the dedicated tools above don't cover. " +
      "Prefer the dedicated tools when available (they have richer descriptions and validation). " +
      "Use this for: less common system endpoints (system/cors, system/email_template, system/event, system/script_type, " +
      "system/lookup, system/cache, system/custom, system/limit, etc.) and for /user/* profile operations. " +
      "Paths are relative to /api/v2 and MUST begin with 'system/' or 'user/'. Provide query as a flat object of " +
      "string values; provide body as a JSON object for POST/PATCH. Returns the raw DreamFactory response.",
    {
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP verb."),
      path: z
        .string()
        .describe(
          "Path relative to /api/v2. MUST start with 'system/' or 'user/'. e.g. 'system/cors', 'system/email_template/3'.",
        ),
      body: z.record(z.unknown()).optional().describe("JSON body for POST/PATCH/PUT/DELETE-with-payload."),
      query: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query string parameters as a flat object."),
    },
    async ({ method, path, body, query }, extra) => {
      // Defense-in-depth: refuse paths that escape the control plane.
      const normalised = path.replace(/^\/+/, "").toLowerCase();
      if (!normalised.startsWith("system/") && !normalised.startsWith("user/")) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error:
                    "path rejected: call_system_api is restricted to 'system/*' and 'user/*' endpoints. " +
                    `Got: '${path}'.`,
                  status: 400,
                  operation: "call_system_api",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch(method, path, {
        auth,
        body,
        query,
      });
      return toToolResponse("call_system_api", result);
    },
  );
}
