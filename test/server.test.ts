import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtExp, shareUrl, computePlayback } from '../src/deezer.ts';

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('jwtExp', () => {
    it('returns the exp claim in ms', () => {
        const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64');
        const token = `aaa.${payload}.bbb`;
        assert.equal(jwtExp(token), 1_700_000_000_000);
    });

    it('returns 0 for garbage tokens', () => {
        assert.equal(jwtExp('not-a-jwt'), 0);
        assert.equal(jwtExp('a.!!!.c'), 0);
    });
});

describe('shareUrl', () => {
    it('builds a deezer.com track link with host attribution', () => {
        assert.equal(
            shareUrl('3135556', '6959367623'),
            'https://deezer.com/track/3135556?host=6959367623&universal_link=1',
        );
    });
});

describe('computePlayback', () => {
    const st = { position: 3, progressMS: 30_000, updatedAt: '2026-11-10T21:00:30.000Z' };
    const now = Date.parse('2026-11-10T21:02:00.000Z'); // 90s after updatedAt

    it('computes startedAt = updatedAt - progressMS', () => {
        const r = computePlayback(st, 200, now);
        assert.equal(r.startedAt, Date.parse('2026-11-10T21:00:00.000Z'));
        assert.equal(r.elapsed, 120);
        assert.equal(r.playing, true);
    });

    it('marks playback as not playing once past the track duration', () => {
        const r = computePlayback(st, 100, now); // 120s elapsed > 100s duration
        assert.equal(r.playing, false);
        assert.equal(r.elapsed, null);
    });

    it('falls back to a 10 minute window when duration is unknown', () => {
        const within = computePlayback(st, null, Date.parse('2026-11-10T21:05:00.000Z'));
        assert.equal(within.playing, true);
        const past = computePlayback(st, null, Date.parse('2026-11-10T21:11:00.000Z'));
        assert.equal(past.playing, false);
    });
});

// ── Config validation ───────────────────────────────────────────────────────

describe('loadConfig', () => {
    const envKeys = [
        'DEEZER_REFRESH_TOKEN',
        'DEEZER_USER_ID',
        'MCP_TRANSPORT',
        'MCP_HOST',
        'MCP_PORT',
        'MCP_AUTH_TOKEN',
    ];
    let saved: Record<string, string | undefined>;
    let tmpDir: string;
    let origCwd: string;

    beforeEach(() => {
        saved = {};
        for (const k of envKeys) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        // Run from a temp dir so the project's .env file is not picked up
        origCwd = process.cwd();
        tmpDir = mkdtempSync(join(tmpdir(), 'deezer-mcp-cfg-'));
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(origCwd);
        rmSync(tmpDir, { recursive: true, force: true });
        for (const k of envKeys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    const validToken = 'x'.repeat(48);

    it('throws when DEEZER_REFRESH_TOKEN is missing', async () => {
        const { loadConfig } = await import('../src/config.ts');
        assert.throws(() => loadConfig(), /DEEZER_REFRESH_TOKEN/);
    });

    it('throws when the refresh token looks too short', async () => {
        process.env.DEEZER_REFRESH_TOKEN = 'short';
        const { loadConfig } = await import('../src/config.ts');
        assert.throws(() => loadConfig(), /too short/);
    });

    it('throws when MCP_AUTH_TOKEN is missing in http mode', async () => {
        process.env.DEEZER_REFRESH_TOKEN = validToken;
        const { loadConfig } = await import('../src/config.ts');
        assert.throws(() => loadConfig(), /MCP_AUTH_TOKEN/);
    });

    it('loads config with defaults when all required vars are set', async () => {
        process.env.DEEZER_REFRESH_TOKEN = validToken;
        process.env.MCP_AUTH_TOKEN = 'test-token';
        const { loadConfig } = await import('../src/config.ts');
        const config = loadConfig();
        assert.equal(config.refreshToken, validToken);
        assert.equal(config.transport, 'http');
        assert.equal(config.host, '127.0.0.1');
        assert.equal(config.port, 3000);
        assert.equal(config.userId, undefined);
    });

    it('allows stdio transport without auth token', async () => {
        process.env.DEEZER_REFRESH_TOKEN = validToken;
        process.env.MCP_TRANSPORT = 'stdio';
        const { loadConfig } = await import('../src/config.ts');
        const config = loadConfig();
        assert.equal(config.transport, 'stdio');
        assert.equal(config.authToken, undefined);
    });

    it('picks up DEEZER_USER_ID and a valid MCP_PORT', async () => {
        process.env.DEEZER_REFRESH_TOKEN = validToken;
        process.env.MCP_AUTH_TOKEN = 'test-token';
        process.env.DEEZER_USER_ID = '6959367623';
        process.env.MCP_PORT = '8080';
        const { loadConfig } = await import('../src/config.ts');
        const config = loadConfig();
        assert.equal(config.userId, '6959367623');
        assert.equal(config.port, 8080);
    });

    it('falls back to 3000 for invalid MCP_PORT values', async () => {
        process.env.DEEZER_REFRESH_TOKEN = validToken;
        process.env.MCP_AUTH_TOKEN = 'test-token';
        const { loadConfig } = await import('../src/config.ts');
        for (const bad of ['abc', '99999', '0', '-1', '', '   ']) {
            process.env.MCP_PORT = bad;
            assert.equal(loadConfig().port, 3000, `MCP_PORT=${JSON.stringify(bad)}`);
        }
    });
});
