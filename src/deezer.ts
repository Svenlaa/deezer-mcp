import type { DeezerMcpConfig } from './config.ts';

// --- pipe (new GraphQL API, JWT auth) ------------------------------------
//
// me.lastKnownQueueState is the playback state clients push on play/pause/
// seek, but modern clients don't push it reliably — /now reads the
// listening history instead (see playerState).
// JWTs live ~6 minutes and are minted by auth.deezer.com/login/renew from
// the long-lived refresh-token cookie, which alone authenticates (no arl
// needed). The token does not rotate destructively, so a static value in
// .env keeps working.

const PIPE = 'https://pipe.deezer.com/api';
const RENEW = 'https://auth.deezer.com/login/renew?jo=p&rto=c&i=c';
const PUBLIC_API = 'https://api.deezer.com';
const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/** exp claim (ms epoch) of a JWT, or 0 if unparseable */
export function jwtExp(token: string): number {
    try {
        return (
            JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString())
                .exp * 1000
        );
    } catch {
        return 0;
    }
}

/** deezer.com share link with ?host= attribution */
export function shareUrl(trackId: string, userId: string): string {
    return `https://deezer.com/track/${trackId}?host=${userId}&universal_link=1`;
}

export interface QueueStateLike {
    position: number;
    progressMS: number;
    updatedAt: string;
}

/**
 * positionMS is the playback position at updatedAt, so play start (ms epoch)
 * is updatedAt - progressMS and the live position is now - play start.
 * Pauses are invisible while they last: the clock keeps running past the
 * pause point, but the resume push snaps the position back correct. Track
 * changes and seeks are instant.
 */
export function computePlayback(
    st: QueueStateLike,
    durationSec: number | null,
    now: number,
): { startedAt: number; elapsed: number | null; playing: boolean } {
    const startedAt = Date.parse(st.updatedAt) - st.progressMS;
    const positionSec = Math.floor((now - startedAt) / 1000);
    const playing =
        durationSec !== null ? positionSec < durationSec : now - startedAt < 10 * 60_000;
    return { startedAt, elapsed: playing ? positionSec : null, playing };
}

/**
 * True when a pushed queue state (lastKnownQueueState) looks like a client
 * is actively playing right now. Modern clients scrobble to listening
 * history without pushing queue state, so a stale push means "not live".
 */
export function isQueueLive(
    st: {
        position?: number;
        progressMS?: number;
        updatedAt?: string;
        queue?: { mediaList?: { id: string }[] };
    },
    durationSec: number | null,
    now: number,
): boolean {
    const curId = st.queue?.mediaList?.[st.position ?? 0]?.id;
    if (curId === undefined) return false;
    return computePlayback(
        {
            position: st.position ?? 0,
            progressMS: st.progressMS ?? 0,
            updatedAt: st.updatedAt ?? '',
        },
        durationSec,
        now,
    ).playing;
}

// Note: Picture.cover.urls is permission-gated on pipe and Track.artist errors
// outright — covers and artist names are resolved via the public
// api.deezer.com/track/{id} endpoint instead (see publicTrack).

// ── Client ────────────────────────────────────────────────────────────────

/** Track shape as returned by pipe tracksByIds / search edges */
export interface PipeTrack {
    id: string;
    title: string | null;
    duration: number | null;
    isrc: string | null;
    bpm: number | null;
    popularity: number | null;
    isExplicit: boolean | null;
    isFavorite: boolean | null;
    hasSynchronizedLyrics: boolean | null;
    releaseDate: string | null;
    contributorNames: string[] | null;
    album: { id: string; displayTitle: string | null } | null;
    /** only present when the query selected lyrics (trackInfo, not TRACK_SEL) */
    lyrics?: { id: string } | null;
}

export interface NowPlaying {
    mode: 'last';
    source: 'player';
    track: {
        id: string;
        url: string;
        title: string | null;
        artist: string | null;
        album: string | null;
        cover: string | null;
        duration: number | null;
    };
    playback: { startedAt: number; elapsed: number | null };
    now: number;
}

const TRACK_SEL = `id title duration isrc bpm popularity isExplicit isFavorite
    hasSynchronizedLyrics releaseDate contributorNames
    album { id displayTitle }`;

// Slimmer selection for playlist track lists — the connection takes no
// pagination args, so huge playlists would otherwise blow the complexity cap.
const PLAYLIST_TRACK_SEL = `id title duration isExplicit contributorNames
    album { id displayTitle }`;

/**
 * Serialize an object as a GraphQL input-object literal. JSON.stringify is NOT
 * valid here — GraphQL input keys are bare names, not quoted strings (verified
 * live: `{"k":…}` is rejected, `{ k: … }` works). String values go through
 * JSON.stringify, which matches GraphQL string escaping, so this stays
 * injection-safe. Keys must come from code, never user input.
 */
export function gqlInput(obj: Record<string, unknown>): string {
    const pairs = Object.entries(obj)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${gqlValue(v)}`);
    return `{ ${pairs.join(', ')} }`;
}

function gqlValue(v: unknown): string {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(gqlValue).join(', ')}]`;
    if (v && typeof v === 'object') return gqlInput(v as Record<string, unknown>);
    return 'null';
}

export class DeezerClient {
    readonly config: DeezerMcpConfig;
    private jwtCache: { token: string; exp: number } | null = null;
    private renewFailedAt = 0;
    private renewError: string | null = null;
    private publicTrackCache = new Map<string, unknown>();
    private accountIdCache: string | null = null;

    constructor(config: DeezerMcpConfig) {
        this.config = config;
    }

    async getJwt(): Promise<string> {
        if (this.jwtCache && this.jwtCache.exp - Date.now() > 60_000) return this.jwtCache.token;
        if (this.renewFailedAt > 0 && Date.now() - this.renewFailedAt < 60_000) {
            const waitSecs = Math.max(
                1,
                Math.ceil((60_000 - (Date.now() - this.renewFailedAt)) / 1000),
            );
            throw new Error(
                `Deezer auth renewal failed earlier (${this.renewError ?? 'unknown'}) — retry permitted in ${waitSecs}s`,
            );
        }
        const res = await fetch(RENEW, {
            method: 'POST',
            headers: {
                cookie: `refresh-token=${this.config.refreshToken}; refresh-token-Deezer=${this.config.refreshToken}`,
                'user-agent': UA,
                referer: 'https://www.deezer.com/us/',
                origin: 'https://www.deezer.com',
            },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            this.renewFailedAt = Date.now();
            this.renewError = `renew failed: ${res.status} (stale refresh token? re-copy it from the browser)`;
            throw new Error(this.renewError);
        }
        const body = (await res.json()) as { jwt?: string };
        if (!body.jwt) {
            this.renewFailedAt = Date.now();
            this.renewError = 'renew returned no jwt';
            throw new Error(this.renewError);
        }
        this.renewFailedAt = 0;
        this.renewError = null;
        this.jwtCache = { token: body.jwt, exp: jwtExp(body.jwt) };
        return this.jwtCache.token;
    }

    async pipe<T>(query: string, retried = false): Promise<T> {
        const jwt = await this.getJwt();
        const res = await fetch(PIPE, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(15_000),
        });
        // A 401 means the cached JWT was rejected server-side — drop it, mint a
        // fresh one and retry the query once.
        if (res.status === 401 && !retried) {
            this.jwtCache = null;
            return this.pipe<T>(query, true);
        }
        if (!res.ok) throw new Error(`pipe failed: ${res.status}`);
        const body = (await res.json()) as {
            data?: T;
            errors?: { message: string }[];
        };
        if (body.errors && body.errors.length > 0) {
            throw new Error(`pipe error: ${body.errors[0]?.message ?? 'unknown'}`);
        }
        return body.data as T;
    }

    /** Public api.deezer.com track metadata (artist name, cover) — pipe gates Track.artist */
    async publicTrack(id: string): Promise<Record<string, any> | null> {
        const cached = this.publicTrackCache.get(id);
        if (cached) return cached as Record<string, any>;
        try {
            const res = await fetch(`${PUBLIC_API}/track/${encodeURIComponent(id)}`, {
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return null;
            const meta = (await res.json()) as Record<string, any>;
            if (this.publicTrackCache.size >= 500) this.publicTrackCache.clear();
            this.publicTrackCache.set(id, meta);
            return meta;
        } catch {
            return null;
        }
    }

    /** Deezer account id (me.id), cached; DEEZER_USER_ID overrides */
    async accountId(): Promise<string> {
        if (this.accountIdCache) return this.accountIdCache;
        if (this.config.userId) {
            this.accountIdCache = this.config.userId;
            return this.accountIdCache;
        }
        const data = await this.pipe<{ me: { id: string } }>('{ me { id } }');
        this.accountIdCache = String(data.me?.id ?? '') || this.config.userId || '';
        return this.accountIdCache;
    }

    /** Share link with ?host= attribution for a track id */
    async trackUrl(trackId: string): Promise<string> {
        return shareUrl(trackId, await this.accountId());
    }

    /** Batch-resolve pipe track ids to full track objects */
    async tracksByIds(ids: string[]): Promise<PipeTrack[]> {
        if (ids.length === 0) return [];
        const data = await this.pipe<{ tracksByIds: PipeTrack[] }>(
            `{ tracksByIds(ids: ${JSON.stringify(ids)}) { ${TRACK_SEL} } }`,
        );
        return data.tracksByIds ?? [];
    }

    /**
     * Last played track (same logic as the /now endpoint). Deezer's pushed
     * queue state (lastKnownQueueState) only moves when a client pushes it,
     * which modern clients don't — listening history always does, so /now
     * just reports the newest scrobble, always in "last" mode.
     */
    async playerState(): Promise<NowPlaying | null> {
        const data = await this.pipe<{
            me: {
                id: string;
                listeningHistoryRawTracks?: { id: string; listenedAt: string }[];
            };
        }>(`{ me { id listeningHistoryRawTracks { id listenedAt } } }`);
        const last = data?.me?.listeningHistoryRawTracks?.[0];
        if (!last) return null;

        const meta = await this.publicTrack(last.id);
        const duration = Number(meta?.duration) || null;
        const userId = String(data.me?.id ?? '') || this.config.userId || '';
        const trackId = String(meta?.id ?? last.id);
        return {
            mode: 'last',
            source: 'player',
            track: {
                id: trackId,
                url: shareUrl(trackId, userId),
                title: meta?.title ?? null,
                artist: meta?.artist?.name ?? null,
                album: meta?.album?.title ?? null,
                cover: meta?.album?.cover_medium ?? null,
                duration,
            },
            playback: { startedAt: Date.parse(last.listenedAt), elapsed: null },
            now: Date.now(),
        };
    }

    /** Raw lastKnownQueueState incl. queue contents and source contexts */
    async queueState(): Promise<Record<string, any>> {
        const data = await this.pipe<{ me: { lastKnownQueueState: Record<string, any> | null } }>(
            `{ me { lastKnownQueueState { position progressMS updatedAt version repeatMode
                queueConfiguration lastClientDetails { userAgent localQueueID locallyUpdatedAt }
                queue { id size queueMetadata { queueId chunkMetadataList { id size } }
                    contexts { id content } mediaList { id type contextId }
                    tracks { edges { contextId node { id } } } }
                originalQueue { id size mediaList { id type } } } } }`,
        );
        return data.me.lastKnownQueueState ?? {};
    }

    async history(limit: number): Promise<{ id: string; listenedAt: string }[]> {
        const data = await this.pipe<{
            me: { listeningHistoryRawTracks: { id: string; listenedAt: string }[] };
        }>(`{ me { listeningHistoryRawTracks { id listenedAt } } }`);
        return (data.me.listeningHistoryRawTracks ?? []).slice(0, limit);
    }

    async recentlyPlayed(limit: number): Promise<unknown[]> {
        const data = await this.pipe<{
            me: {
                recentlyPlayed: {
                    edges: { node: unknown }[];
                };
            };
        }>(
            `{ me { recentlyPlayed(first: ${limit}) { edges { node {
                __typename
                ... on Album { id displayTitle }
                ... on Playlist { id title }
                ... on Artist { id name }
                ... on Flow { id title }
                ... on FlowConfig { id title }
                ... on SmartTracklist { id title }
                ... on Livestream { id name }
                ... on Mix { id }
            } } } } }`,
        );
        return (data.me.recentlyPlayed?.edges ?? []).map((e) => e.node);
    }

    async search(
        query: string,
    ): Promise<{
        topResult: ({ __typename: string } & Record<string, unknown>) | null;
        tracks: PipeTrack[];
        albums: { id: string; displayTitle: string | null }[];
        artists: { id: string; name: string | null }[];
        playlists: { id: string; title: string | null }[];
    }> {
        const data = await this.pipe<{
            search: {
                topResult: {
                    content: ({ __typename: string } & Record<string, unknown>) | null;
                } | null;
                results: {
                    tracks: { edges: { node: PipeTrack }[] };
                    albums: { edges: { node: { id: string; displayTitle: string | null } }[] };
                    artists: { edges: { node: { id: string; name: string | null } }[] };
                    playlists: { edges: { node: { id: string; title: string | null } }[] };
                };
            };
        }>(
            `{ search(query: ${JSON.stringify(query)}) {
                topResult { content { __typename
                    ... on Track { id title }
                    ... on Artist { id name }
                    ... on Album { id displayTitle }
                    ... on Playlist { id title } } }
                results {
                    tracks { edges { node { ${TRACK_SEL} } } }
                    albums { edges { node { id displayTitle } } }
                    artists { edges { node { id name } } }
                    playlists { edges { node { id title } } }
                } } }`,
        );
        const s = data.search;
        return {
            topResult: s.topResult?.content ?? null,
            tracks: (s.results.tracks?.edges ?? []).map((e) => e.node),
            albums: (s.results.albums?.edges ?? []).map((e) => e.node),
            artists: (s.results.artists?.edges ?? []).map((e) => e.node),
            playlists: (s.results.playlists?.edges ?? []).map((e) => e.node),
        };
    }

    async trackInfo(trackId: string): Promise<PipeTrack | null> {
        const data = await this.pipe<{ track: PipeTrack | null }>(
            `{ track(trackId: ${JSON.stringify(trackId)}) { ${TRACK_SEL} lyrics { id } } }`,
        );
        return data.track ?? null;
    }

    async lyrics(trackId: string): Promise<{
        id: string | null;
        text: string | null;
        synchronized: { line: string; milliseconds: number }[];
    } | null> {
        const data = await this.pipe<{
            track: {
                lyrics: {
                    id: string;
                    text: string | null;
                    synchronizedLines: { line: string; milliseconds: number }[] | null;
                } | null;
            } | null;
        }>(
            `{ track(trackId: ${JSON.stringify(trackId)}) { lyrics { id text
                synchronizedLines { line lrcTimestamp milliseconds duration } } } }`,
        );
        const l = data.track?.lyrics;
        if (!l) return null;
        return {
            id: l.id,
            text: l.text,
            synchronized: (l.synchronizedLines ?? []).map((s) => ({
                line: s.line,
                milliseconds: s.milliseconds,
            })),
        };
    }

    async favorites(
        kind: 'tracks' | 'albums' | 'artists' | 'playlists',
        limit: number,
    ): Promise<{ estimatedCount: number | null; items: unknown[] }> {
        // Only the requested kind's edges are fetched — selecting all four with
        // full track selections would needlessly eat the server's complexity cap.
        const edgesSel: Record<typeof kind, string> = {
            tracks: `tracks(first: ${limit}) { edges { node { ${TRACK_SEL} } favoritedAt } }`,
            albums: `albums(first: ${limit}) { edges { node { id displayTitle } } }`,
            artists: `artists(first: ${limit}) { edges { node { id name } } }`,
            playlists: `playlists(first: ${limit}) { edges { node { id title } } }`,
        };
        const data = await this.pipe<{
            me: {
                userFavorites: {
                    estimatedTracksCount: number;
                    estimatedAlbumsCount: number;
                    estimatedArtistsCount: number;
                    estimatedPlaylistsCount: number;
                } & Record<string, unknown>;
            };
        }>(
            `{ me { userFavorites {
                estimatedTracksCount estimatedAlbumsCount estimatedArtistsCount estimatedPlaylistsCount
                ${edgesSel[kind]}
            } } }`,
        );
        const f = data.me.userFavorites;
        const counts: Record<string, number> = {
            tracks: f.estimatedTracksCount,
            albums: f.estimatedAlbumsCount,
            artists: f.estimatedArtistsCount,
            playlists: f.estimatedPlaylistsCount,
        };
        const edges =
            (f[kind] as { edges?: { node: unknown }[] } | undefined)?.edges ?? [];
        const items =
            kind === 'tracks'
                ? edges.map((e) => {
                      const edge = e as { node: PipeTrack; favoritedAt: string };
                      return { ...edge.node, favoritedAt: edge.favoritedAt };
                  })
                : edges.map((e) => (e as { node: unknown }).node);
        return { estimatedCount: counts[kind] ?? null, items };
    }

    async likeTrack(trackId: string): Promise<void> {
        await this.pipe(`mutation { addTrackToFavorite(trackId: ${JSON.stringify(trackId)}) { __typename } }`);
    }

    async unlikeTrack(trackId: string): Promise<void> {
        await this.pipe(`mutation { removeTrackFromFavorite(trackId: ${JSON.stringify(trackId)}) { __typename } }`);
    }

    // ── Playlist CRUD ───────────────────────────────────────────────────────
    // Mutation outputs only expose a `vast` field, so tools echo the input and
    // create_playlist additionally looks the new playlist up by title.

    async createPlaylist(input: {
        title: string;
        description?: string;
        isPrivate: boolean;
        isCollaborative: boolean;
    }): Promise<unknown> {
        return this.pipe(
            `mutation { createPlaylist(input: ${gqlInput(input)}) { __typename } }`,
        );
    }

    async updatePlaylist(
        playlistId: string,
        patch: Partial<{
            title: string;
            description: string;
            isPrivate: boolean;
            isCollaborative: boolean;
        }>,
    ): Promise<unknown> {
        return this.pipe(
            `mutation { updatePlaylist(input: ${gqlInput({ playlistId, ...patch })}) { __typename } }`,
        );
    }

    async deletePlaylist(playlistId: string): Promise<void> {
        await this.pipe(
            `mutation { deletePlaylist(input: ${gqlInput({ playlistId })}) { __typename } }`,
        );
    }

    async addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
        await this.pipe(
            `mutation { addTracksToPlaylist(input: ${gqlInput({ playlistId, trackIds })}) { __typename } }`,
        );
    }

    async removeTracksFromPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
        await this.pipe(
            `mutation { removeTracksFromPlaylist(input: ${gqlInput({ playlistId, trackIds })}) { __typename } }`,
        );
    }

    async moveTrackInPlaylist(
        playlistId: string,
        trackId: string,
        afterTrackId?: string,
    ): Promise<void> {
        await this.pipe(
            `mutation { moveTrackInPlaylist(input: ${gqlInput({ playlistId, trackId, afterTrackId })}) { __typename } }`,
        );
    }

    async appendAlbumToPlaylist(playlistId: string, albumId: string): Promise<void> {
        await this.pipe(
            `mutation { appendAlbumTracksToPlaylist(input: ${gqlInput({ playlistId, albumId })}) { __typename } }`,
        );
    }

    async playlists(limit: number): Promise<unknown[]> {
        const data = await this.pipe<{
            me: {
                playlists: {
                    edges: {
                        node: {
                            id: string;
                            title: string;
                            isPrivate: boolean;
                            estimatedTracksCount: number;
                        };
                    }[];
                };
            };
        }>(
            `{ me { playlists(first: ${limit}) { edges { node { id title isPrivate estimatedTracksCount } } } } }`,
        );
        return (data.me.playlists?.edges ?? []).map((e) => e.node);
    }

    async playlistTracks(
        playlistId: string,
        limit: number,
    ): Promise<{
        playlist: { id: string; title: string | null; isPrivate: boolean; estimatedTracksCount: number | null; owner: string | null } | null;
        tracks: { track: PipeTrack; addedAt: string | null }[];
    }> {
        const data = await this.pipe<{
            playlist: {
                id: string;
                title: string;
                isPrivate: boolean;
                estimatedTracksCount: number;
                owner: { name: string | null } | null;
                tracks: { edges: { node: PipeTrack; addedAt: string | null }[] };
            } | null;
        }>(
            `{ playlist(playlistId: ${JSON.stringify(playlistId)}) { id title isPrivate
                estimatedTracksCount owner { name }
                tracks { edges { node { ${PLAYLIST_TRACK_SEL} } addedAt } } } }`,
        );
        const p = data.playlist;
        if (!p) throw new Error(`Playlist not found: ${playlistId}`);
        return {
            playlist: {
                id: p.id,
                title: p.title,
                isPrivate: p.isPrivate,
                estimatedTracksCount: p.estimatedTracksCount,
                owner: p.owner?.name ?? null,
            },
            tracks: (p.tracks?.edges ?? []).slice(0, limit).map((e) => ({
                track: e.node,
                addedAt: e.addedAt,
            })),
        };
    }

    async flow(): Promise<{ id: string; title: string | null; subTitle: string | null; tracks: PipeTrack[] } | null> {
        const data = await this.pipe<{
            me: {
                flow: {
                    id: string;
                    title: string;
                    subTitle: string | null;
                    tracks: { track: PipeTrack }[];
                } | null;
            };
        }>(`{ me { flow { id title subTitle tracks { track { ${TRACK_SEL} } } } } }`);
        const f = data.me.flow;
        if (!f) return null;
        return {
            id: f.id,
            title: f.title,
            subTitle: f.subTitle,
            tracks: (f.tracks ?? []).map((t) => t.track),
        };
    }

    async madeForMe(limit: number): Promise<unknown[]> {
        const data = await this.pipe<{
            me: { madeForMe: { edges: { node: unknown }[] } };
        }>(
            `{ me { madeForMe(first: ${limit}) { edges { node { __typename id title subTitle } } } } }`,
        );
        return (data.me.madeForMe?.edges ?? []).map((e) => e.node);
    }

    async flowConfig(flowConfigId: string): Promise<{
        id: string;
        title: string | null;
        tracks: PipeTrack[];
    } | null> {
        const data = await this.pipe<{
            flowConfig: { id: string; title: string; tracks: { track: PipeTrack }[] } | null;
        }>(
            `{ flowConfig(flowConfigId: ${JSON.stringify(flowConfigId)}) { id title tracks { track { ${TRACK_SEL} } } } }`,
        );
        const f = data.flowConfig;
        if (!f) return null;
        return { id: f.id, title: f.title, tracks: (f.tracks ?? []).map((t) => t.track) };
    }

    async trackMix(trackIds: string[], limit: number): Promise<PipeTrack[]> {
        // Note: the server ignores the limit arg (verified: limit 5 → 41 tracks),
        // pagination is client-side slicing like search/queue/playlist tracks.
        const data = await this.pipe<{ trackMix: { tracks: { track: PipeTrack }[] } }>(
            `{ trackMix(trackIds: ${JSON.stringify(trackIds)}, limit: ${limit}, startWithInputTrack: true) {
                tracks { track { ${TRACK_SEL} } } } }`,
        );
        return (data.trackMix?.tracks ?? []).map((t) => t.track).slice(0, limit);
    }

    async charts(): Promise<{
        country: { position: number | null; node: PipeTrack }[];
        worldwide: { position: number | null; node: PipeTrack }[];
        personal: {
            tracks: PipeTrack[];
            artists: { id: string; name: string | null }[];
            albums: { id: string; displayTitle: string | null }[];
            playlists: { id: string; title: string | null }[];
        };
    }> {
        // Note: only `tracks` exists server-side on charts.country/worldwide —
        // albums/artists/playlists are in the introspected schema but rejected
        // ("ChartsCountryAlbums not found"). Personal charts (me.charts) do
        // serve all four kinds.
        const data = await this.pipe<{
            charts: {
                country: { tracks: { edges: { node: PipeTrack; position: number | null }[] } };
                worldwide: { tracks: { edges: { node: PipeTrack; position: number | null }[] } };
            };
            me: {
                charts: {
                    tracks: { edges: { node: PipeTrack }[] };
                    artists: { edges: { node: { id: string; name: string | null } }[] };
                    albums: { edges: { node: { id: string; displayTitle: string | null } }[] };
                    playlists: { edges: { node: { id: string; title: string | null } }[] };
                };
            };
        }>(
            `{ charts {
                country { tracks { edges { node { ${TRACK_SEL} } position } } }
                worldwide { tracks { edges { node { ${TRACK_SEL} } position } } }
            }
            me { charts {
                tracks { edges { node { ${TRACK_SEL} } } }
                artists { edges { node { id name } } }
                albums { edges { node { id displayTitle } } }
                playlists { edges { node { id title } } }
            } } }`,
        );
        const edges = (c: { edges: { node: PipeTrack; position: number | null }[] } | null | undefined) =>
            (c?.edges ?? []).map((e) => ({ position: e.position, node: e.node }));
        return {
            country: edges(data.charts.country?.tracks),
            worldwide: edges(data.charts.worldwide?.tracks),
            personal: {
                tracks: (data.me.charts.tracks?.edges ?? []).map((e) => e.node),
                artists: (data.me.charts.artists?.edges ?? []).map((e) => e.node),
                albums: (data.me.charts.albums?.edges ?? []).map((e) => e.node),
                playlists: (data.me.charts.playlists?.edges ?? []).map((e) => e.node),
            },
        };
    }

    async playerStatus(): Promise<Record<string, any>> {
        const data = await this.pipe<{
            me: {
                id: string;
                user: { name: string | null } | null;
                isQueueListUpNextEnabled: boolean | null;
                lastKnownQueueState: {
                    updatedAt: string;
                    lastClientDetails: {
                        userAgent: string | null;
                        localQueueID: string | null;
                        locallyUpdatedAt: string | null;
                    } | null;
                } | null;
            };
            permissions: {
                access: { hasAccess: boolean | null; hasLimitedPermissions: boolean | null };
                player: {
                    allowNext: boolean | null;
                    nextLimit: number | null;
                    allowPrevious: boolean | null;
                    allowSeek: boolean | null;
                    allowRepeat: boolean | null;
                    allowQeueListAccess: boolean | null;
                    allowShuffle: boolean | null;
                };
            };
            health: { health: boolean; hello: string | null };
        }>(
            `{ me { id user { name } isQueueListUpNextEnabled lastKnownQueueState { updatedAt
                lastClientDetails { userAgent localQueueID locallyUpdatedAt } } }
                permissions { access { hasAccess hasLimitedPermissions }
                    player { allowNext nextLimit allowPrevious allowSeek allowRepeat allowQeueListAccess allowShuffle } }
                health { health hello } }`,
        );
        return data;
    }
}
