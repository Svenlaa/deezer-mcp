import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { styleText } from 'node:util';

// Load .env file if present — native Node.js, no dotenv dependency
if (existsSync('.env')) {
    loadEnvFile('.env');
}

export interface DeezerMcpConfig {
    /** Long-lived Deezer refresh-token cookie value; mints short-lived JWTs */
    refreshToken: string;
    /** Deezer account id for ?host= on share links; falls back to me.id */
    userId?: string;
    /** Transport mode: "http" (default) or "stdio" */
    transport: 'http' | 'stdio';
    /** HTTP listen host */
    host: string;
    /** HTTP listen port */
    port: number;
    /** Bearer token required on every MCP request when transport=http */
    authToken?: string;
}

function required(...names: string[]): string {
    for (const name of names) {
        const value = process.env[name];
        if (value) return value;
    }
    throw new Error(
        styleText('red', `Missing required environment variable: ${names.join(' or ')}`),
    );
}

function optional(name: string, fallback: string): string {
    return process.env[name] ?? fallback;
}

const DEFAULT_PORT = 3000;

function portOrDefault(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_PORT;
    return parsed;
}

export function loadConfig(): DeezerMcpConfig {
    const config: DeezerMcpConfig = {
        refreshToken: required('DEEZER_REFRESH_TOKEN'),
        userId: process.env.DEEZER_USER_ID || undefined,
        transport: process.env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http',
        host: optional('MCP_HOST', '127.0.0.1'),
        port: portOrDefault(process.env.MCP_PORT),
        authToken: process.env.MCP_AUTH_TOKEN,
    };

    if (config.refreshToken.length < 32) {
        throw new Error(
            styleText(
                'red',
                'DEEZER_REFRESH_TOKEN looks too short — copy the full refresh-token cookie value ' +
                    'from your browser (deezer.com → dev tools → storage → cookies).',
            ),
        );
    }

    if (config.transport === 'http' && !config.authToken) {
        throw new Error(
            styleText(
                'red',
                'MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http — ' +
                    'the HTTP endpoint exposes your private Deezer data and must not be unauthenticated.',
            ),
        );
    }

    return config;
}
