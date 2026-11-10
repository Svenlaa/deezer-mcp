import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DeezerClient, type PipeTrack } from './deezer.ts';

// ---------------------------------------------------------------------------
// Shared schemas / helpers
// ---------------------------------------------------------------------------

// Deezer ids are numeric strings (e.g. "3135556"); the ^\d+$ check keeps user
// input from breaking out of the GraphQL query string or the public API path.
const trackIdSchema = z
    .string()
    .regex(/^\d+$/, 'must be a numeric Deezer track id, e.g. "3135556"')
    .describe('Deezer track id, e.g. "3135556"');

const playlistIdSchema = z
    .string()
    .regex(/^\d+$/, 'must be a numeric Deezer playlist id, e.g. "9431754082"')
    .describe('Deezer playlist id, e.g. "9431754082"');

const albumIdSchema = z
    .string()
    .regex(/^\d+$/, 'must be a numeric Deezer album id, e.g. "302127"')
    .describe('Deezer album id, e.g. "302127"');

const trackIdsSchema = z
    .array(trackIdSchema)
    .min(1)
    .max(500)
    .describe('Deezer track ids to add/remove');

const flowConfigIdSchema = z
    .string()
    .regex(/^[\w-]+$/, 'letters, digits, underscores and hyphens only, e.g. "genre-pop"')
    .describe('Flow config id, e.g. "genre-pop", "genre-rock", "happy"');

const limitSchema = (max: number, fallback: number) =>
    z.number().int().min(1).max(max).optional().default(fallback)
        .describe(`Maximum number of items to return (default: ${fallback})`);

function shapeTrack(t: PipeTrack, url: string): Record<string, unknown> {
    return {
        id: t.id,
        title: t.title,
        artist: t.contributorNames?.join(', ') ?? null,
        album: t.album?.displayTitle ?? null,
        albumId: t.album?.id ?? null,
        cover: null,
        duration: t.duration,
        isrc: t.isrc,
        // pipe reports 0 (not null) for unset BPM — normalize to null
        bpm: t.bpm || null,
        popularity: t.popularity,
        isExplicit: t.isExplicit,
        isFavorite: t.isFavorite,
        hasSynchronizedLyrics: t.hasSynchronizedLyrics,
        releaseDate: t.releaseDate,
        url,
    };
}

/** shapeTrack for a whole list, with share links resolved via the account id */
async function shapeAll(
    client: DeezerClient,
    tracks: PipeTrack[],
): Promise<Record<string, unknown>[]> {
    return Promise.all(
        tracks.map(async (t) => shapeTrack(t, await client.trackUrl(t.id))),
    );
}

function json(data: unknown): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
    return { isError: true, content: [{ type: 'text' as const, text }] };
}

/** Parse a server-supplied JSON string field, falling back to the raw value */
function parseJsonField(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw ?? null;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, client: DeezerClient): void {
    // ── now_playing ─────────────────────────────────────────────────────────
    server.registerTool(
        'now_playing',
        {
            title: 'Now Playing',
            description:
                'What is playing on the Deezer account right now, with live elapsed time, ' +
                'cover and a deezer.com share link (?host= attribution). ' +
                'mode "live" means actively playing, "last" means the last known state.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            const state = await client.playerState();
            // Empty state is a normal payload, not an error
            if (!state) return json({ playing: false, now: Date.now() });
            return json(state);
        },
    );

    // ── queue ───────────────────────────────────────────────────────────────
    server.registerTool(
        'queue',
        {
            title: 'Playback Queue',
            description:
                'The synced playback queue around the current position — 2 tracks before it, ' +
                'then up to `limit` upcoming ("up next") — with repeat mode, the source context ' +
                '(e.g. which playlist it came from) and resolved track titles.',
            inputSchema: {
                limit: limitSchema(200, 50),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const st = await client.queueState();
            const mediaList: { id: string; type: string; contextId: string | null }[] =
                st.queue?.mediaList ?? [];
            const position: number = st.position ?? 0;
            const start = Math.max(0, position - 2);
            const slice = mediaList.slice(start, start + args.limit);
            const tracks = await client.tracksByIds(slice.map((m) => m.id));
            const byId = new Map(tracks.map((t) => [t.id, t]));
            const contexts: { id: string; content: unknown }[] = st.queue?.contexts ?? [];
            return json({
                position,
                progressMS: st.progressMS ?? null,
                updatedAt: st.updatedAt ?? null,
                repeatMode: st.repeatMode ?? null,
                queueConfiguration: parseJsonField(st.queueConfiguration),
                size: st.queue?.size ?? mediaList.length,
                contexts: contexts.map((c) => {
                    const parsed = parseJsonField(c.content);
                    return {
                        id: c.id,
                        ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                            ? parsed
                            : { content: parsed }),
                    };
                }),
                tracks: await Promise.all(
                    slice.map(async (m, i) => ({
                        index: start + i,
                        current: start + i === position,
                        type: m.type,
                        contextId: m.contextId,
                        ...shapeTrack(
                            byId.get(m.id) ?? ({ id: m.id } as PipeTrack),
                            await client.trackUrl(m.id),
                        ),
                    })),
                ),
            });
        },
    );

    // ── listening_history ───────────────────────────────────────────────────
    server.registerTool(
        'listening_history',
        {
            title: 'Listening History',
            description: 'Recently listened tracks with timestamps, most recent first.',
            inputSchema: { limit: limitSchema(100, 20) },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const entries = await client.history(args.limit);
            const tracks = await client.tracksByIds(entries.map((e) => e.id));
            const byId = new Map(tracks.map((t) => [t.id, t]));
            const shaped = await shapeAll(
                client,
                entries.map((e) => byId.get(e.id) ?? ({ id: e.id } as PipeTrack)),
            );
            return json({
                history: entries.map((e, i) => ({ listenedAt: e.listenedAt, ...shaped[i] })),
            });
        },
    );

    // ── recently_played ─────────────────────────────────────────────────────
    server.registerTool(
        'recently_played',
        {
            title: 'Recently Played',
            description:
                'Recently played albums, playlists, artists and flows (the app home recents). ' +
                'Note: plain tracks do not appear here — use listening_history for those.',
            inputSchema: { limit: limitSchema(50, 20) },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => json({ recentlyPlayed: await client.recentlyPlayed(args.limit) }),
    );

    // ── search ──────────────────────────────────────────────────────────────
    server.registerTool(
        'search',
        {
            title: 'Search',
            description: 'Search Deezer for tracks, albums, artists and playlists.',
            inputSchema: {
                query: z.string().min(1).describe('Search query'),
                limit: limitSchema(50, 10),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const s = await client.search(args.query);
            return json({
                topResult: s.topResult,
                tracks: await shapeAll(client, s.tracks.slice(0, args.limit)),
                albums: s.albums.slice(0, args.limit),
                artists: s.artists.slice(0, args.limit),
                playlists: s.playlists.slice(0, args.limit),
            });
        },
    );

    // ── track_info ──────────────────────────────────────────────────────────
    server.registerTool(
        'track_info',
        {
            title: 'Track Info',
            description:
                'Full metadata for a track: title, artist, album, duration, ISRC, BPM, ' +
                'popularity, explicit/favorite flags, lyrics availability and a share link.',
            inputSchema: { trackId: trackIdSchema },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const t = await client.trackInfo(args.trackId);
            if (!t) return err(`Track not found: ${args.trackId}`);
            const meta = await client.publicTrack(args.trackId);
            return json({
                ...shapeTrack(t, await client.trackUrl(t.id)),
                artist: meta?.artist?.name ?? t.contributorNames?.join(', ') ?? null,
                album: meta?.album?.title ?? t.album?.displayTitle ?? null,
                cover: meta?.album?.cover_xl ?? null,
                lyricsId: t.lyrics?.id ?? null,
            });
        },
    );

    // ── lyrics ──────────────────────────────────────────────────────────────
    server.registerTool(
        'lyrics',
        {
            title: 'Lyrics',
            description:
                'Plain-text and synchronized (time-stamped) lyrics for a track, ' +
                'when Deezer has them (hasSynchronizedLyrics on track_info).',
            inputSchema: { trackId: trackIdSchema },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const l = await client.lyrics(args.trackId);
            // No lyrics is an empty state, not an error
            if (!l) return json({ trackId: args.trackId, lyrics: null });
            return json(l);
        },
    );

    // ── favorites ───────────────────────────────────────────────────────────
    server.registerTool(
        'favorites',
        {
            title: 'Favorites',
            description: 'Loved tracks, albums, artists or playlists of the account.',
            inputSchema: {
                kind: z
                    .enum(['tracks', 'albums', 'artists', 'playlists'])
                    .optional()
                    .default('tracks')
                    .describe('Which favorites to list (default: tracks)'),
                limit: limitSchema(100, 20),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const f = await client.favorites(args.kind, args.limit);
            return json({
                kind: args.kind,
                estimatedCount: f.estimatedCount,
                items:
                    args.kind === 'tracks'
                        ? await Promise.all(
                              f.items.map(async (i) => {
                                  const { favoritedAt, ...track } = i as PipeTrack & {
                                      favoritedAt?: string;
                                  };
                                  return {
                                      ...shapeTrack(track, await client.trackUrl(track.id)),
                                      favoritedAt: favoritedAt ?? null,
                                  };
                              }),
                          )
                        : f.items,
            });
        },
    );

    // ── like_track / unlike_track ───────────────────────────────────────────
    server.registerTool(
        'like_track',
        {
            title: 'Like Track',
            description: 'Add a track to the account favorites (loved tracks).',
            inputSchema: { trackId: trackIdSchema },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args) => {
            await client.likeTrack(args.trackId);
            return json({ liked: args.trackId, url: await client.trackUrl(args.trackId) });
        },
    );

    server.registerTool(
        'unlike_track',
        {
            title: 'Unlike Track',
            description: 'Remove a track from the account favorites (loved tracks).',
            inputSchema: { trackId: trackIdSchema },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args) => {
            await client.unlikeTrack(args.trackId);
            return json({ unliked: args.trackId });
        },
    );

    // ── playlists / playlist_tracks ─────────────────────────────────────────
    server.registerTool(
        'playlists',
        {
            title: 'My Playlists',
            description:
                'List the account\'s own playlists — their ids feed playlist_tracks ' +
                '(recently_played also surfaces playlist ids).',
            inputSchema: { limit: limitSchema(100, 20) },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => json({ playlists: await client.playlists(args.limit) }),
    );

    server.registerTool(
        'playlist_tracks',
        {
            title: 'Playlist Tracks',
            description:
                'Tracks of a playlist (id from playlists or recently_played), ' +
                'with the date each was added.',
            inputSchema: {
                playlistId: playlistIdSchema,
                limit: limitSchema(200, 50),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const p = await client.playlistTracks(args.playlistId, args.limit);
            return json({
                playlist: p.playlist,
                tracks: await Promise.all(
                    p.tracks.map(async (t) => ({
                        addedAt: t.addedAt,
                        ...shapeTrack(t.track, await client.trackUrl(t.track.id)),
                    })),
                ),
            });
        },
    );

    // ── playlist CRUD ───────────────────────────────────────────────────────
    server.registerTool(
        'create_playlist',
        {
            title: 'Create Playlist',
            description: 'Create a new playlist on the account. Returns the created playlist (looked up by title).',
            inputSchema: {
                title: z.string().min(1).max(120).describe('Playlist title'),
                description: z.string().max(2000).optional().describe('Playlist description'),
                isPrivate: z.boolean().optional().default(false).describe('Private playlist (default: false)'),
                isCollaborative: z.boolean().optional().default(false).describe('Allow others to add tracks (default: false)'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
            await client.createPlaylist({
                title: args.title,
                ...(args.description !== undefined ? { description: args.description } : {}),
                isPrivate: args.isPrivate,
                isCollaborative: args.isCollaborative,
            });
            const playlist = await client.findPlaylistByTitle(args.title);
            return json({ created: true, playlist });
        },
    );

    server.registerTool(
        'update_playlist',
        {
            title: 'Update Playlist',
            description: 'Rename or change settings of a playlist (id from playlists or recently_played). Only provided fields are changed.',
            inputSchema: {
                playlistId: playlistIdSchema,
                title: z.string().min(1).max(120).optional().describe('New title'),
                description: z.string().max(2000).optional().describe('New description'),
                isPrivate: z.boolean().optional().describe('New privacy setting'),
                isCollaborative: z.boolean().optional().describe('New collaborative setting'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            const { playlistId, ...patch } = args;
            await client.updatePlaylist(playlistId, patch);
            return json({ updated: playlistId, changes: patch });
        },
    );

    server.registerTool(
        'delete_playlist',
        {
            title: 'Delete Playlist',
            description: 'Permanently delete a playlist from the account.',
            inputSchema: { playlistId: playlistIdSchema },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            await client.deletePlaylist(args.playlistId);
            return json({ deleted: args.playlistId });
        },
    );

    server.registerTool(
        'add_tracks_to_playlist',
        {
            title: 'Add Tracks To Playlist',
            description: 'Append tracks to the end of a playlist.',
            inputSchema: {
                playlistId: playlistIdSchema,
                trackIds: trackIdsSchema,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
            await client.addTracksToPlaylist(args.playlistId, args.trackIds);
            return json({ playlistId: args.playlistId, added: args.trackIds.length, trackIds: args.trackIds });
        },
    );

    server.registerTool(
        'remove_tracks_from_playlist',
        {
            title: 'Remove Tracks From Playlist',
            description: 'Remove tracks from a playlist by track id.',
            inputSchema: {
                playlistId: playlistIdSchema,
                trackIds: trackIdsSchema,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            await client.removeTracksFromPlaylist(args.playlistId, args.trackIds);
            return json({ playlistId: args.playlistId, removed: args.trackIds.length, trackIds: args.trackIds });
        },
    );

    server.registerTool(
        'move_track_in_playlist',
        {
            title: 'Move Track In Playlist',
            description: 'Move a track within a playlist to a new position (after afterTrackId, or to the top if omitted).',
            inputSchema: {
                playlistId: playlistIdSchema,
                trackId: trackIdSchema,
                afterTrackId: trackIdSchema.optional().describe('Track after which to insert; omit for the top'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args) => {
            await client.moveTrackInPlaylist(args.playlistId, args.trackId, args.afterTrackId);
            return json({ playlistId: args.playlistId, trackId: args.trackId, afterTrackId: args.afterTrackId ?? null });
        },
    );

    server.registerTool(
        'append_album_to_playlist',
        {
            title: 'Append Album To Playlist',
            description: 'Append all tracks of an album to the end of a playlist.',
            inputSchema: {
                playlistId: playlistIdSchema,
                albumId: albumIdSchema,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
            await client.appendAlbumToPlaylist(args.playlistId, args.albumId);
            return json({ playlistId: args.playlistId, albumId: args.albumId });
        },
    );

    // ── discovery ───────────────────────────────────────────────────────────
    server.registerTool(
        'flow',
        {
            title: 'Flow',
            description: 'The personalized Flow infinite mix currently offered to the account.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            const f = await client.flow();
            if (!f) return json({ flow: null });
            return json({ ...f, tracks: await shapeAll(client, f.tracks) });
        },
    );

    server.registerTool(
        'made_for_me',
        {
            title: 'Made For Me',
            description: 'Personalized playlists and smart tracklists ("inspired by…") for the account.',
            inputSchema: { limit: limitSchema(50, 10) },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => json({ madeForMe: await client.madeForMe(args.limit) }),
    );

    server.registerTool(
        'flow_config',
        {
            title: 'Flow Config',
            description:
                'Tracks of a genre- or mood-based Flow config, e.g. "genre-pop", ' +
                '"genre-rock", "happy". Use flow for the personalized Flow mix and ' +
                'flow_config for a genre/mood variant of it.',
            inputSchema: { flowConfigId: flowConfigIdSchema },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const f = await client.flowConfig(args.flowConfigId);
            if (!f) return err(`Unknown flow config: ${args.flowConfigId}`);
            return json({ ...f, tracks: await shapeAll(client, f.tracks) });
        },
    );

    server.registerTool(
        'track_mix',
        {
            title: 'Track Mix',
            description:
                'A radio-style mix seeded from one or more track ids — ' +
                '"play something like this". Returns similar tracks in order.',
            inputSchema: {
                trackIds: z.array(trackIdSchema).min(1).max(10).describe('Seed track ids'),
                limit: limitSchema(100, 25),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            const tracks = await client.trackMix(args.trackIds, args.limit);
            return json({ seeds: args.trackIds, tracks: await shapeAll(client, tracks) });
        },
    );

    // ── charts ──────────────────────────────────────────────────────────────
    server.registerTool(
        'charts',
        {
            title: 'Charts',
            description:
                'Charts: country and worldwide top tracks (with chart position), plus the ' +
                'account\'s personal charts (tracks, artists, albums, playlists).',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            const c = await client.charts();
            const chart = async (list: { position: number | null; node: PipeTrack }[]) =>
                Promise.all(
                    list.map(async (t) => ({
                        position: t.position,
                        ...shapeTrack(t.node, await client.trackUrl(t.node.id)),
                    })),
                );
            return json({
                country: await chart(c.country),
                worldwide: await chart(c.worldwide),
                personal: {
                    tracks: await shapeAll(client, c.personal.tracks),
                    artists: c.personal.artists,
                    albums: c.personal.albums,
                    playlists: c.personal.playlists,
                },
            });
        },
    );

    // ── player_status ───────────────────────────────────────────────────────
    server.registerTool(
        'player_status',
        {
            title: 'Player Status',
            description:
                'Auth sanity check: account, API health, which client last pushed playback state, ' +
                'and what the player permissions allow (next/seek/repeat/shuffle…). ' +
                'Note: the pipe API can only read this state — cross-device playback control ' +
                'is not possible over it.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => json(await client.playerStatus()),
    );
}
