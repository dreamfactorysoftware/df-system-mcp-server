import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type RegisterToolOptions } from "./define";
import { z } from "zod";
import { dreamFactoryFetch, getAuthForSession, toToolResponse } from "../dreamfactory";
import { maskResult } from "../redact";

/**
 * App tools — DreamFactory "apps" are the records that issue API keys.
 * Each app is bound to one role; that role's role_service_access_by_role_id
 * determines what calls authenticated by that app's api_key may do.
 *
 * Read tools mask `api_key` (see src/redact.ts): the LLM sees
 * `api_key: null` + `api_key_hint: "…" + last 4 chars`. Only create_app
 * returns a real key, once, because the caller has no other way to get it.
 */
export function registerAppTools(server: McpServer, opts?: RegisterToolOptions): void {
  defineTool(
    server,
    opts,
    "list_apps",
    "List all DreamFactory apps (each app issues one API key and binds to one role). " +
      "Returns id, name, description, role_id, type, is_active. API keys are MASKED: `api_key` is null and " +
      "`api_key_hint` holds \"…\" plus the key's last 4 characters, enough to tell keys apart or match one a " +
      "user quotes, never enough to use. Never ask for or try to reconstruct full keys.",
    {
      filter: z.string().optional().describe('SQL-like filter, e.g. "is_active=true".'),
      fields: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    async ({ filter, fields, limit }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      // include_count + default limit=100 so the LLM gets `meta.count` and a
      // non-truncated list. See list_roles for rationale.
      const result = await dreamFactoryFetch("GET", "system/app", {
        auth,
        query: {
          filter,
          fields,
          limit: limit ?? 100,
          include_count: true,
        },
      });
      return toToolResponse("list_apps", maskResult(result));
    },
  );

  defineTool(
    server,
    opts,
    "get_app",
    "Retrieve a single app by id: name, description, role_id, type, is_active and launch settings. " +
      "The API key is MASKED: `api_key` is null and `api_key_hint` is \"…\" plus its last 4 characters, which " +
      "identifies the key without exposing it. The full key is not retrievable through this server; admins can " +
      "copy it from the DreamFactory admin UI (Apps page).",
    {
      id: z.number().int().describe("Numeric app id."),
    },
    async ({ id }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("GET", `system/app/${id}`, { auth });
      return toToolResponse("get_app", maskResult(result));
    },
  );

  defineTool(
    server,
    opts,
    "create_app",
    "Create a new DreamFactory app, which generates a new API key. This is the ONLY tool that returns a full, " +
      "unmasked key (in the response's `api_key` field): hand it to the user once, and do not repeat it later; " +
      "list_apps/get_app only show a masked hint afterwards. " +
      "Apps are how external clients authenticate. Each app is bound to a SINGLE role (`role_id`); the role determines " +
      "what that API key may call. Set `type` to 0 (None / no app launch) for headless API consumers — that is the " +
      "default and almost always correct.",
    {
      name: z.string().describe('Human-readable app name, e.g. "MobileApp" or "PartnerIntegration".'),
      description: z.string().optional(),
      role_id: z
        .number()
        .int()
        .describe("Numeric id of the role this API key inherits permissions from. Required for any access."),
      type: z
        .number()
        .int()
        .optional()
        .default(0)
        .describe(
          "App type: 0 = None (headless API client, the usual case), 1 = web, 2 = path, 3 = url, 4 = remote.",
        ),
      is_active: z.boolean().optional().default(true),
    },
    async ({ name, description, role_id, type, is_active }, extra) => {
      const auth = getAuthForSession(extra.sessionId);
      const result = await dreamFactoryFetch("POST", "system/app", {
        auth,
        query: { fields: "*" },
        body: {
          resource: [
            {
              name,
              description,
              role_id,
              type,
              is_active,
            },
          ],
        },
      });
      // Deliberately NOT masked: the new key is only useful if the caller sees it.
      return toToolResponse("create_app", result);
    },
  );
}
