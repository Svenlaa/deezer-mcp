# deezer-mcp

MCP (Model Context Protocol) server for [Deezer](https://www.deezer.com). Exposes your account's **now playing**, **queue**, **listening history**, **search**, **lyrics**, **favorites**, **playlists**, **discovery** (Flow / mixes) and **charts** via Deezer's internal `pipe` GraphQL API, authenticated with just the long-lived `refresh-token` cookie (short-lived JWTs are minted automatically; no arl needed).

Built for **Node.js 26+** — runs TypeScript natively with zero build step, uses built-in `node:test` and `process.loadEnvFile`. Only 2 runtime dependencies.

## Tools

| Tool | Description |
|---|---|
| `now_playing` | What's playing right now, with live elapsed time, cover and a `deezer.com` share link (`?host=` attribution). `mode: live` = actively playing, `last` = last known state. |
| `queue` | The synced queue around the current position (2 tracks before, then up to `limit` upcoming), with repeat mode, source context (e.g. originating playlist) and resolved titles. |
| `listening_history` | Recently listened tracks with timestamps, most recent first. |
| `recently_played` | Recently played albums / playlists / artists / flows (plain tracks are in `listening_history`). |
| `search` | Search tracks, albums, artists, playlists + top result. |
| `track_info` | Full metadata for a track (artist, album, ISRC, BPM, popularity, flags, lyrics id, share link). |
| `lyrics` | Plain-text and synchronized (time-stamped) lyrics for a track. |
| `favorites` | Loved tracks / albums / artists / playlists. |
| `like_track` / `unlike_track` | Add / remove a track from favorites. |
| `playlists` / `playlist_tracks` | List own playlists; tracks of a playlist with added-at dates. |
| `flow` | The personalized Flow infinite mix. |
| `made_for_me` | Personalized playlists / smart tracklists ("inspired by…"). |
| `flow_config` | Tracks of a Flow config, e.g. `genre-pop`, `happy`. |
| `track_mix` | Radio-style mix seeded from track ids ("play something like this"). |
| `charts` | Country and worldwide top tracks (with chart position), plus personal charts (tracks, artists, albums, playlists). |
| `player_status` | Auth sanity check: account, API health, last client that pushed playback state, player permissions. |

Note: the pipe API can **read** playback state but cannot command another device
to play — `player_status` reports what the current session is allowed to do;
cross-device control (Deezer Connect) uses a different channel.

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `DEEZER_REFRESH_TOKEN` | yes | — | `refresh-token` cookie value from your browser (deezer.com → dev tools → storage → cookies, after logging in) |
| `MCP_AUTH_TOKEN` | yes (http mode) | — | Bearer token required on every MCP request |
| `MCP_TRANSPORT` | no | `http` | `http` (Streamable HTTP) or `stdio` |
| `MCP_HOST` | no | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` | no | `3000` | HTTP port |
| `DEEZER_USER_ID` | no | `me.id` | Account id for `?host=` share links |

A `.env` file in the working directory is loaded automatically via `process.loadEnvFile()`.
Keep it private: `chmod 600 .env` — it contains the refresh token. `.env` is gitignored.

## Usage

```bash
pnpm install
pnpm start          # HTTP server on 127.0.0.1:3000 (bearer auth)
MCP_TRANSPORT=stdio pnpm start   # local stdio mode (no token needed)
pnpm dev            # run with --watch for development
pnpm test           # run tests with node:test
```

### HTTP mode (remote, e.g. Vibe web)

The server speaks **Streamable HTTP** at `POST /mcp` (stateless). Every request
requires `Authorization: Bearer $MCP_AUTH_TOKEN`. `GET /health` is unauthenticated.

```
Vibe web ──HTTPS──► reverse proxy (TLS) ──► deezer-mcp :3000/mcp ──► pipe.deezer.com
```

Point your MCP client at `https://your-host/mcp` with the bearer token.
Put a TLS-terminating reverse proxy (Caddy/nginx) in front — the server itself
listens on plain HTTP on localhost.

### stdio mode (local)

```json
{
  "mcpServers": {
    "deezer": {
      "command": "node",
      "args": ["/path/to/deezer-mcp/src/index.ts"],
      "env": { "MCP_TRANSPORT": "stdio", "DEEZER_REFRESH_TOKEN": "…" }
    }
  }
}
```

## Notes on the pipe API

- JWTs live ~6 minutes and are renewed automatically from the refresh token; on renew failure the client backs off for 60 s.
- Query complexity is capped (~25000) server-side — tools keep queries small.
- `Track.artist` is gated on pipe; artist names are resolved via the public `api.deezer.com/track/{id}` endpoint.
- Queue/search/playlist track connections take no pagination args, and `trackMix` ignores its `limit` arg — tools slice client-side.
- Track/playlist ids are format-validated (`^\d+$`) so user input cannot inject into the GraphQL query or the public API URL path.
