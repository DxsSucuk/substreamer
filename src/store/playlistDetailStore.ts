import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

import { ensureCached, prefetchCoverArt } from '../services/imageCacheService';
import { coverArtForPlaylist } from '../utils/coverArtId';
import {
  ensureCoverArtAuth,
  getPlaylist,
  type PlaylistWithSongs,
} from '../services/subsonicService';
import { ratingStore } from './ratingStore';

interface PlaylistDetailEntry {
  playlist: PlaylistWithSongs;
  /** Timestamp (Date.now()) when this entry was fetched from the server. */
  retrievedAt: number;
}

export interface PlaylistDetailState {
  /** Playlist details indexed by playlist ID. */
  playlists: Record<string, PlaylistDetailEntry>;
  /** Fetch playlist from API, store it, and return it. Returns null on failure.
   *  Pass `{ prefetchCovers: false }` to skip the eager cover-art cache —
   *  used by the background library sync so bulk prefetches don't kick off
   *  hundreds of image downloads. User-facing fetches omit the flag so art
   *  still pre-caches. */
  fetchPlaylist: (id: string, opts?: { prefetchCovers?: boolean }) => Promise<PlaylistWithSongs | null>;
  /** Reorder a track within the cached playlist entry. */
  reorderTracks: (id: string, fromIndex: number, toIndex: number) => void;
  /** Remove a track from the cached playlist entry by index. */
  removeTrack: (id: string, trackIndex: number) => void;
  /** Eagerly bump local play stats for a just-scrobbled song across every
   *  cached playlist that contains it (a song can appear in multiple
   *  playlists). No-op for playlists that don't reference the song. */
  applyLocalPlay: (songId: string, now: string) => void;
  /** Remove a playlist entry from the cache entirely. */
  removePlaylist: (id: string) => void;
  /** Clear all cached playlist details. */
  clearPlaylists: () => void;
}

const PERSIST_KEY = 'substreamer-playlist-details';

export const playlistDetailStore = create<PlaylistDetailState>()(
  persist(
    (set, get) => ({
      playlists: {},

      fetchPlaylist: async (id: string, opts?: { prefetchCovers?: boolean }) => {
        const prefetchCovers = opts?.prefetchCovers ?? true;
        await ensureCoverArtAuth();
        const data = await getPlaylist(id);
        if (data) {
          const ratingEntries = (data.entry ?? []).map((s) => ({
            id: s.id,
            serverRating: s.userRating ?? 0,
          }));
          ratingStore.getState().reconcileRatings(ratingEntries);
          set({
            playlists: {
              ...get().playlists,
              [id]: { playlist: data, retrievedAt: Date.now() },
            },
          });

          // Proactively cache cover art for new IDs so they survive offline.
          // Skipped during bulk sync — see prefetchCovers contract above.
          if (prefetchCovers) {
            const playlistArtId = coverArtForPlaylist(data);
            if (playlistArtId) ensureCached(playlistArtId).catch(() => { /* non-critical */ });
            if (data.entry?.length) prefetchCoverArt(data.entry);
          }
        }
        return data;
      },

      reorderTracks: (id, fromIndex, toIndex) => {
        const entry = get().playlists[id];
        if (!entry) return;
        const entries = [...(entry.playlist.entry ?? [])];
        if (
          fromIndex < 0 || fromIndex >= entries.length ||
          toIndex < 0 || toIndex >= entries.length ||
          fromIndex === toIndex
        ) return;
        const [moved] = entries.splice(fromIndex, 1);
        entries.splice(toIndex, 0, moved);
        set({
          playlists: {
            ...get().playlists,
            [id]: {
              ...entry,
              playlist: { ...entry.playlist, entry: entries, songCount: entries.length },
            },
          },
        });
      },

      removeTrack: (id, trackIndex) => {
        const entry = get().playlists[id];
        if (!entry) return;
        const entries = [...(entry.playlist.entry ?? [])];
        if (trackIndex < 0 || trackIndex >= entries.length) return;
        const removed = entries[trackIndex];
        entries.splice(trackIndex, 1);
        const newDuration = (entry.playlist.duration ?? 0) - (removed.duration ?? 0);
        set({
          playlists: {
            ...get().playlists,
            [id]: {
              ...entry,
              playlist: {
                ...entry.playlist,
                entry: entries,
                songCount: entries.length,
                duration: Math.max(0, newDuration),
              },
            },
          },
        });
      },

      applyLocalPlay: (songId, now) => {
        const current = get().playlists;
        let touched = false;
        const next: Record<string, PlaylistDetailEntry> = {};
        for (const [id, entry] of Object.entries(current)) {
          const entries = entry.playlist.entry ?? [];
          let matched = false;
          const updatedEntries = entries.map((track) => {
            if (track.id !== songId) return track;
            matched = true;
            return {
              ...track,
              playCount: (track.playCount ?? 0) + 1,
              played: now,
            };
          });
          if (matched) {
            touched = true;
            next[id] = {
              ...entry,
              playlist: { ...entry.playlist, entry: updatedEntries },
            };
          } else {
            next[id] = entry;
          }
        }
        if (touched) set({ playlists: next });
      },

      removePlaylist: (id) => {
        const { [id]: _, ...rest } = get().playlists;
        set({ playlists: rest });
      },

      clearPlaylists: () => set({ playlists: {} }),
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        playlists: state.playlists,
      }),
    }
  )
);
