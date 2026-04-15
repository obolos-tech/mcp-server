#!/usr/bin/env node
/**
 * Obolos MCP Server — auto-generated from the CLI command registry.
 *
 * Single source of truth lives in @obolos_tech/cli. This file iterates
 * `registry.all()` and exposes each Command as an MCP tool using the same
 * input schema that powers `obolos <cmd> --help`. No duplicated tool
 * definitions, no drift possible.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registry } from '@obolos_tech/cli/commands';
import { loadConfig } from '@obolos_tech/cli/runtime/config';
import { createHttpClient } from '@obolos_tech/cli/runtime/http';
import { toZodShape } from '@obolos_tech/cli/schema/zod-shape';
const config = loadConfig();
const http = createHttpClient(config.apiUrl);
const ctx = { config, http, source: 'mcp', json: true, dryRun: false };
const server = new McpServer({ name: 'obolos', version: '0.5.0' });
for (const cmd of registry.all()) {
    if (cmd.mcp?.expose === false)
        continue;
    const toolName = cmd.name.replace(/\./g, '_');
    const description = [
        cmd.summary,
        cmd.description ?? '',
        cmd.examples?.length ? 'Examples:\n' + cmd.examples.map((e) => '  ' + e).join('\n') : '',
    ].filter(Boolean).join('\n\n');
    server.registerTool(toolName, {
        description,
        inputSchema: toZodShape(cmd.input),
        annotations: {
            readOnlyHint: cmd.mcp?.readOnly,
            destructiveHint: cmd.mcp?.destructive,
        },
    }, async (input) => {
        try {
            const output = await cmd.run(input ?? {}, ctx);
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify(output, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2),
                    }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err.message}` }],
                isError: true,
            };
        }
    });
}
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[obolos-mcp] ready — ${registry.all().length} tools registered from CLI`);
}
main().catch((err) => {
    console.error('[obolos-mcp] fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map