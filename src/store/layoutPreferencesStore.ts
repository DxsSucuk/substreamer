import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

export type ItemLayout = 'list' | 'grid';
export type AlbumSortOrder = 'artist' | 'title';
export type ArtistAlbumSortOrder = 'newest' | 'oldest';
export type DateFormat = 'yyyy/mm/dd' | 'yyyy/dd/mm';
/** Which cover art a song shows: the parent album's, or the track's own. */
export type SongCoverArtMode = 'album' | 'perTrack';
export type ListLength = 20 | 30 | 50 | 100;

export const LIST_LENGTH_DISPLAY_CAP = 20;

export interface LayoutPreferencesState {
  albumLayout: ItemLayout;
  artistLayout: ItemLayout;
  playlistLayout: ItemLayout;
  songLayout: ItemLayout;
  favSongLayout: ItemLayout;
  favAlbumLayout: ItemLayout;
  favArtistLayout: ItemLayout;
  albumSortOrder: AlbumSortOrder;
  artistAlbumSortOrder: ArtistAlbumSortOrder;
  dateFormat: DateFormat;
  songCoverArtMode: SongCoverArtMode;
  listLength: ListLength;
  includePartialInDownloadedFilter: boolean;
  setAlbumLayout: (layout: ItemLayout) => void;
  setArtistLayout: (layout: ItemLayout) => void;
  setPlaylistLayout: (layout: ItemLayout) => void;
  setSongLayout: (layout: ItemLayout) => void;
  setFavSongLayout: (layout: ItemLayout) => void;
  setFavAlbumLayout: (layout: ItemLayout) => void;
  setFavArtistLayout: (layout: ItemLayout) => void;
  setAlbumSortOrder: (order: AlbumSortOrder) => void;
  setArtistAlbumSortOrder: (order: ArtistAlbumSortOrder) => void;
  setDateFormat: (format: DateFormat) => void;
  setSongCoverArtMode: (mode: SongCoverArtMode) => void;
  setListLength: (length: ListLength) => void;
  setIncludePartialInDownloadedFilter: (value: boolean) => void;
}

const PERSIST_KEY = 'substreamer-layout-preferences';

export const layoutPreferencesStore = create<LayoutPreferencesState>()(
  persist(
    (set) => ({
      albumLayout: 'list',
      artistLayout: 'list',
      playlistLayout: 'list',
      songLayout: 'list',
      favSongLayout: 'list',
      favAlbumLayout: 'list',
      favArtistLayout: 'list',
      albumSortOrder: 'artist',
      artistAlbumSortOrder: 'newest',
      dateFormat: 'yyyy/mm/dd',
      songCoverArtMode: 'album',
      listLength: 20,
      includePartialInDownloadedFilter: false,
      setAlbumLayout: (albumLayout) => set({ albumLayout }),
      setArtistLayout: (artistLayout) => set({ artistLayout }),
      setPlaylistLayout: (playlistLayout) => set({ playlistLayout }),
      setSongLayout: (songLayout) => set({ songLayout }),
      setFavSongLayout: (favSongLayout) => set({ favSongLayout }),
      setFavAlbumLayout: (favAlbumLayout) => set({ favAlbumLayout }),
      setFavArtistLayout: (favArtistLayout) => set({ favArtistLayout }),
      setAlbumSortOrder: (albumSortOrder) => set({ albumSortOrder }),
      setArtistAlbumSortOrder: (artistAlbumSortOrder) =>
        set({ artistAlbumSortOrder }),
      setDateFormat: (dateFormat) => set({ dateFormat }),
      setSongCoverArtMode: (songCoverArtMode) => set({ songCoverArtMode }),
      setListLength: (listLength) => set({ listLength }),
      setIncludePartialInDownloadedFilter: (includePartialInDownloadedFilter) =>
        set({ includePartialInDownloadedFilter }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        albumLayout: state.albumLayout,
        artistLayout: state.artistLayout,
        playlistLayout: state.playlistLayout,
        songLayout: state.songLayout,
        favSongLayout: state.favSongLayout,
        favAlbumLayout: state.favAlbumLayout,
        favArtistLayout: state.favArtistLayout,
        albumSortOrder: state.albumSortOrder,
        artistAlbumSortOrder: state.artistAlbumSortOrder,
        dateFormat: state.dateFormat,
        songCoverArtMode: state.songCoverArtMode,
        listLength: state.listLength,
        includePartialInDownloadedFilter: state.includePartialInDownloadedFilter,
      }),
    }
  )
);
