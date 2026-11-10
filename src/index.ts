#!/usr/bin/env node
/**
 * deezer-mcp — MCP server for Deezer
 *
 * Exposes the account's now-playing state, queue, listening history, search,
 * lyrics, favorites, playlists, discovery (Flow/mixes) and charts via the
 * pipe GraphQL API (JWT auth minted from the DEEZER_REFRESH_TOKEN cookie).
 *
 * Runs on Node.js 26+ with native TypeScript type stripping — no build step.
 *
 * Transports:
 *   http  (default) — Streamable HTTP on MCP_HOST:MCP_PORT, bearer-token auth
 *   stdio           — local subprocess mode (MCP_TRANSPORT=stdio)
 *
 * Required env vars:
 *   DEEZER_REFRESH_TOKEN   — refresh-token cookie value from the browser
 *   MCP_AUTH_TOKEN         — bearer token for HTTP mode (required)
 *
 * Optional env vars:
 *   DEEZER_USER_ID   — account id for ?host= share links (default: me.id)
 *   MCP_TRANSPORT    — "http" (default) or "stdio"
 *   MCP_HOST         — HTTP bind address (default: 127.0.0.1)
 *   MCP_PORT         — HTTP port (default: 3000)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { styleText } from 'node:util';
import { loadConfig, type DeezerMcpConfig } from './config.ts';
import { DeezerClient } from './deezer.ts';
import { registerTools } from './tools.ts';
import { SERVER_ICON_SRC } from './icon.ts';

// ── MCP server factory (fresh instance per HTTP request in stateless mode) ──
function createMcpServer(client: DeezerClient): McpServer {
    const server = new McpServer(
        {
            name: 'deezer-mcp',
            version: '1.0.0',
            title: 'Deezer MCP',
            icons: [{ src: SERVER_ICON_SRC, mimeType: 'image/svg+xml', sizes: ['512x512'] }],
        },
        { capabilities: { tools: {} } },
    );
    registerTools(server, client);
    return server;
}

// ── Bearer token check (timing-safe) ────────────────────────────────────────
function isAuthorized(req: IncomingMessage, token: string): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice(7), 'utf8');
    const expected = Buffer.from(token, 'utf8');
    if (presented.length !== expected.length) return false;
    return timingSafeEqual(presented, expected);
}

// ── Read and JSON-parse a request body ──────────────────────────────────────
function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// ── HTTP transport ──────────────────────────────────────────────────────────
function startHttpServer(config: DeezerMcpConfig, client: DeezerClient): void {
    const server = createServer((req, res) => {
        void (async () => {
            // CORS — allow browser-based MCP clients (e.g. Vibe web)
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
            res.setHeader(
                'Access-Control-Allow-Headers',
                'Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID',
            );
            res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // Health check — no auth, for load balancers / uptime probes
            if (req.method === 'GET' && req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, server: 'deezer-mcp' }));
                return;
            }

            // Favicon — no auth, so browsers hitting the endpoint get an icon
            if (req.method === 'GET' && (req.url === '/favicon.ico' || req.url === '/favicon.svg')) {
                try {
                    const icon = readFileSync(new URL('../assets/icon.svg', import.meta.url));
                    res.writeHead(200, {
                        'Content-Type': 'image/svg+xml',
                        'Cache-Control': 'public, max-age=86400',
                    });
                    res.end(icon);
                } catch {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Not found' }));
                }
                return;
            }

            // Everything else requires the bearer token
            if (!isAuthorized(req, config.authToken!)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }

            if (req.url !== '/mcp' && req.url !== '/') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            if (req.method !== 'POST') {
                // Stateless mode: GET (SSE stream) and DELETE are not supported
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed — use POST' }));
                return;
            }

            // Stateless: fresh server + transport per request
            const mcpServer = createMcpServer(client);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            res.on('close', () => {
                void transport.close();
                void mcpServer.close();
            });
            await mcpServer.connect(transport);
            const body = await readBody(req);
            await transport.handleRequest(req, res, body);
        })().catch((err: unknown) => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
    });

    server.listen(config.port, config.host, () => {
        console.error(
            styleText(
                'green',
                `[deezer-mcp] HTTP server on http://${config.host}:${config.port}/mcp (bearer auth)`,
            ),
        );
    });

    const shutdown = (signal: string): void => {
        console.error(styleText('yellow', `[deezer-mcp] Received ${signal}, shutting down…`));
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── stdio transport ─────────────────────────────────────────────────────────
async function startStdio(config: DeezerMcpConfig, client: DeezerClient): Promise<void> {
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
    console.error(styleText('green', '[deezer-mcp] stdio server running'));
    const shutdown = async (signal: string): Promise<void> => {
        console.error(styleText('yellow', `[deezer-mcp] Received ${signal}, shutting down…`));
        await server.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const config = loadConfig();

    const client = new DeezerClient(config);

    if (config.transport === 'http') {
        startHttpServer(config, client);
    } else {
        await startStdio(config, client);
    }
}

main().catch((err: unknown) => {
    console.error(styleText('red', `[deezer-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
});
