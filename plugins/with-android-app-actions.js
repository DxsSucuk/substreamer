/**
 * Wire Android App Actions so Google Assistant can route
 * `"Hey Google, play [artist|album|song|playlist|genre] on Substreamer"`
 * into the app via a `substreamer://play?...` deep link.
 *
 * Two output sites:
 *  1. `android/app/src/main/res/xml/shortcuts.xml` — declares the
 *     `actions.intent.PLAY_MUSIC` capability with schema.org dotted
 *     parameter names mapped to URL-template keys, plus the required
 *     fallback `VIEW` intent (Google rejects shortcuts.xml without one).
 *  2. `AndroidManifest.xml` — the canonical
 *     `<meta-data android:name="android.app.shortcuts" .../>` (NOT the
 *     legacy `com.google.android.actions` name, which no longer routes
 *     through Assistant's modern NLU) + a BROWSABLE intent-filter on
 *     MainActivity for `substreamer://play`.
 *
 * The deep link lands on the Expo Router `play` route (`src/app/play.tsx`),
 * which maps the query params → a MediaSearchRequest and dispatches through
 * carService's `dispatchVoiceSearchRequest` — the same resolver + playback
 * path CarPlay / Android Auto tap-to-play uses.
 *
 * Adapted from the RNQP demo's plugin. App-name-explicit routing needs Play
 * Store publication (Internal Testing works); dev uses the Google Assistant
 * Android Studio plugin.
 */
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCHEME = 'substreamer';

const SHORTCUTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <capability android:name="actions.intent.PLAY_MUSIC">
    <intent>
      <url-template android:value="${SCHEME}://play{?artist,album,song,playlist,genre}" />
      <parameter android:name="song.byArtist.name" android:key="artist" />
      <parameter android:name="song.inAlbum.name" android:key="album" />
      <parameter android:name="song.name" android:key="song" />
      <parameter android:name="playlist.name" android:key="playlist" />
      <parameter android:name="song.genre" android:key="genre" />
    </intent>
    <intent>
      <action android:name="android.intent.action.VIEW" />
      <data android:scheme="${SCHEME}" android:host="play" />
    </intent>
  </capability>
</shortcuts>
`;

const withShortcutsXml = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'shortcuts.xml'), SHORTCUTS_XML, 'utf8');
      return cfg;
    },
  ]);

const withShortcutsMetaData = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;
    application['meta-data'] = application['meta-data'] || [];
    const already = application['meta-data'].some(
      (md) => md.$?.['android:name'] === 'android.app.shortcuts',
    );
    if (!already) {
      application['meta-data'].push({
        $: {
          'android:name': 'android.app.shortcuts',
          'android:resource': '@xml/shortcuts',
        },
      });
    }
    // Add a BROWSABLE intent filter for substreamer://play so Assistant's
    // deep-link routing has a guaranteed target (Expo's default scheme filter
    // is DEFAULT-only; this adds BROWSABLE for the play path).
    const mainActivity = application.activity?.find(
      (act) => act.$?.['android:name'] === '.MainActivity',
    );
    if (mainActivity) {
      mainActivity['intent-filter'] = mainActivity['intent-filter'] || [];
      const hasBrowsablePlay = mainActivity['intent-filter'].some((f) =>
        f.data?.some(
          (d) => d.$?.['android:scheme'] === SCHEME && d.$?.['android:host'] === 'play',
        ),
      );
      if (!hasBrowsablePlay) {
        mainActivity['intent-filter'].push({
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          category: [
            { $: { 'android:name': 'android.intent.category.DEFAULT' } },
            { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
          ],
          data: [{ $: { 'android:scheme': SCHEME, 'android:host': 'play' } }],
        });
      }
    }
    return cfg;
  });

module.exports = (config) => withShortcutsMetaData(withShortcutsXml(config));
