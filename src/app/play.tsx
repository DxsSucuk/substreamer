import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';

import { dispatchVoiceSearchRequest } from '../services/headlessMediaService';
import { buildMediaSearchRequest } from '../services/voiceDeepLinkMapper';

/**
 * Deep-link landing route for `substreamer://play?...` URLs fired by Google
 * Assistant's App Actions PLAY_MUSIC handler (declared in
 * plugins/with-android-app-actions.js → shortcuts.xml). The url-template
 * `substreamer://play{?artist,album,song,playlist,genre}` routes here; we map
 * the query params to a MediaSearchRequest, dispatch through the same
 * headlessMediaService resolver + playback path CarPlay / Android Auto uses, then
 * redirect to the tabs so the user lands on the player with playback started.
 */
export default function PlayDeepLinkRoute() {
  const params = useLocalSearchParams<{
    artist?: string;
    album?: string;
    song?: string;
    playlist?: string;
    genre?: string;
  }>();
  const dispatchedRef = useRef(false);

  useEffect(() => {
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    const request = buildMediaSearchRequest(params);
    if (request) void dispatchVoiceSearchRequest(request);
    router.replace('/(tabs)');
  }, [params]);

  return null;
}
