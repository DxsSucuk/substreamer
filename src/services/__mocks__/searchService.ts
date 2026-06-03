/**
 * Shared Jest automatic mock for searchService.
 *
 * Activated with: jest.mock('../../services/searchService')
 * or jest.mock('../services/searchService') depending on depth.
 */

const EMPTY_RESULTS = { albums: [], artists: [], songs: [] };

export const performOnlineSearch = jest.fn().mockResolvedValue(EMPTY_RESULTS);
export const performOfflineSearch = jest.fn().mockResolvedValue(EMPTY_RESULTS);
export const getOfflineSongsByGenre = jest.fn().mockReturnValue([]);
