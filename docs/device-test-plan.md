# Device test plan

Outstanding manual tests. Every row is **Do** (what to tap) and **Expect** (what you should see).
If Expect doesn't happen, that's the bug.

Suggested order: **G → B → C → D**, with **F1** whenever you next rebuild Android, and **E** parked
until you have a TestFlight/release build.

---

## G. Library sync — paging, retry and pause

The album counter on the sync card shows what **this run** pulled. On a server whose fast-path
enumeration is short of its real library, that number sits below the library total on purpose.

| # | Do in the app | Expect |
|---|---|---|
| G2 | Mid-sync, turn wifi/data off for a few seconds, then back on. | Sync carries on. A single blip does not stop it. |
| G5 | Get it into the paused state, force-quit, relaunch, open the sync card. | Still shows paused with the reason — not "syncing" with nothing happening. **Failed 2026-08-18 (resumed itself); fixed, needs a retest.** |

*Passed 2026-08-18: G1 (full sync, one path, no mid-run restart), G3 (pause on sustained request
failures), G4 (Resume), G6 (Restart), G7 (back-to-back syncs), G8 (legacy toggle on then off),
G9 (album count climbs without stalling).*

---

## B. Reap — the delete-detection pass

The reap only fires on the launch **after** a full sync. Every test here is:
Library & Data → Library Sync → **Sync library**, wait for it to finish, force-quit, relaunch, look.

| # | Do in the app | Expect |
|---|---|---|
| B4a | On the server, ADD an album and rescan. In the app, Library → Albums → pull to refresh. | The new album appears. (Pull-to-refresh runs a newest-album probe; it does not re-download the library.) |
| B4b | Rename a playlist on the server, or star a track from another client. Pull to refresh on Playlists, then Artists. | The rename shows. These two lists always refetch in full, unlike Albums. |
| B4c | On the server, DELETE an album and rescan. Pull to refresh on Albums. | The album is still listed — removals are only picked up by Sync Library, which is what B5/B6 test. Not a bug. |
| B5 | Turn ON Legacy sync. On the server, delete one album's folder and rescan the server. Run a full sync. | Sync finishes instead of hanging or starting over. Next launch does not re-walk the whole library. |
| B6 | The walkthrough below — needs content added and removed on the server. | Throwaway album disappears; downloaded album, starred track and playlist all survive. |

### B6 walkthrough — the only test that proves deletion actually happens

A reap that deletes nothing logs the same "0" as a completely broken one, so this is the only check
that proves the DELETE works. Use junk content so nothing real is at risk.

1. On the server, add a throwaway album (a folder with one or two junk tracks). Rescan the server.
2. In the app: Library & Data → Library Sync → **Sync library**. Wait for it to finish.
3. Confirm the throwaway album appears in Library → Albums.
4. Make sure all three of these exist at the same time: **a downloaded album**, **a starred track**,
   and **a playlist with tracks**. They carry protections that must hold through the delete.
5. On the server, delete the throwaway album's folder. Rescan the server.
6. In the app: **Sync library** again. Force-quit, relaunch.

**Expect:** the throwaway album is gone from Library → Albums, and the downloaded album, starred
track and playlist are all still present and still work. With the dev console open,
`[library-reap] done` should report 1 album and its songs.

---

## C. Regression sweep

### Lyrics

*Passed 2026-08-18: C2 (no-lyrics track doesn't spin or refetch), C8 (offline lyrics browser:
no refresh swipe, delete still works).*

| # | Do in the app | Expect |
|---|---|---|
| C1 | Start a track, open the player. Note the counts on Library & Data → Cached Lyrics. Background the app, let 2–3 tracks change, come back with the player still open. | Current track's lyrics load. Cached count rose by at most one — nothing was fetched while you were away. |
| C3 | Cached Lyrics → browse. Swipe a row one way. | Delete action appears and removes the entry. |
| C4 | Swipe a row the other way. | Refresh action appears and refetches from the server. |
| C5 | Swipe a row fully in each direction. | The action fires without needing a second tap. |
| C6 | With something playing, tap a **different** song's entry in the browser. | Its lyrics show, and do NOT auto-scroll or highlight in time with the playing track. |
| C7 | Note the synced/unsynced counts, delete one entry, go back to the card. | The count went down. |
| C9 | Tablet in landscape, player collapsed. Play through several tracks, then expand the player. | Lyrics load on expand, and the cached count did not rise while collapsed. |

### Home and browsing

*Passed 2026-08-18: C10 (Home album sections render with cover art), C11 (star AND rating
both show on Home without a refresh), C12 (album genres and year survive artist -> album
navigation), C13 (genre chip -> Tuned In mix builds and plays), C14 (Songs, Albums and Artists all end cleanly at the bottom), C18 ("A Horse With No Name"
filed under A), C19 (no jump/reorder/flash when a filter is toggled mid-list).*

| # | Do in the app | Expect |
|---|---|---|
| C15 | From deep in a list, scroll back up to the top. | Rows fill back in, no blank gaps, no jumping. |
| C16 | Switch the library layout to grid, repeat C14. | Same behaviour as the list layout. |
| C17 | Tap letters on the A–Z scroller: no filter, then Downloaded, then Favourites, in both sort orders. | Always lands on rows starting with that letter. |

**Open bugs found during this sweep (both in the shared list views, both iOS):**

- **Scroll-to-top (status-bar tap) doesn't return to the start of the list.** Lands at the top of the
  loaded keyset window, or leaves the list blank. `onStartReached` prepends rows mid-animation and
  `scrollToTopTrigger` remounts the list. Fix: handle RN's `onScrollToTop` and reset to the first page.
- **Alphabet scroller runs behind the MiniPlayer.** It has a `topInset` but no bottom inset, so it
  centres over the full screen height and `#` and `Z` are untappable. Fix: add a `bottomInset`.

### Refresh

| # | Do in the app | Expect |
|---|---|---|
| C20 | Library → Songs with the Favourites filter ON, pull to refresh. | Favourites re-fetch — a star changed on another client shows up. |
| C21 | Downloaded filter ON, pull to refresh. | The library refreshes, not just the filtered view. |
| C22 | Turn on offline mode, pull down on any list. | Nothing happens. No error, no hang. |
| C23 | Watch the spinner on any pull-to-refresh. | Visible long enough to actually see. |

### History, mixes and shares

*Passed 2026-08-19: C24 (My Listening and the history browser fully populated), C26 (Time Machine
plus the current time-of-day mix — the test wrongly said "Right Now"; there is no such option, the
mix is named for the current slot, `tunedInService.ts:47-53`), C28 (Home genre chips build a mix), C29 (genre suggestions identical before and after the
library fetch).*

| # | Do in the app | Expect |
|---|---|---|
| C25 | Backup & Restore → create a backup. Clear history from the Listening History card. Restore the backup. | History comes back with titles, artwork and full track details. |
| C27 | Library & Data → Shares. Create one, edit one, delete one. Force-quit, relaunch, reopen Shares. | All three changes stuck. |
| C30 | Log in to a server that does not support sharing. | Share options hidden or disabled — no errors, no crash. |

### Downloads

| # | Do in the app | Expect |
|---|---|---|
| C31 | Queue several albums for download. Cancel one still queued; cancel another mid-download. | Both disappear cleanly and the rest keep going. |
| C32 | Force a download to fail (turn off wifi mid-download), then hit retry. Force-quit and relaunch. | Retry works. The failed item still lists its songs after the relaunch. |

---

## D. Upgrade pass — install the OLD build first

Before upgrading, make sure you have: saved bookmarks, a download queue part-finished, some
completed downloads, and listening history.

| # | Do in the app | Expect |
|---|---|---|
| D1 | Upgrade, open Home → Resume bookmarks. Then force-quit, relaunch, look again. | Every bookmark is there with its full queue — **both** times. |
| D2 | Upgrade with a download queue still part-finished. | Picks up again with the right songs in the right order. |
| D3 | Upgrade, turn on offline mode, launch. Check the shares list and the genre chips on Home. | Both still populated. |
| D4 | Search for a track you had downloaded. Build a Tuned In mix while offline. | Search finds it; the mix includes downloaded tracks. |
| D5 | Home → My Listening on the FIRST launch after upgrading. | Totals are right immediately, not blank until a second launch. |
| D6 | Watch that first launch with a large history. | No freeze on the splash, no stall a few seconds in. Older history rows fill in genre and year. |
| D7 | Offline, check genre chips on downloaded music. | Genres are there. |
| D8 | Play a track within a few seconds of that first launch. | It scrobbles normally. |
| D9 | Once it has settled: history, top songs, and a track's details. | All render, with genres and artwork. |
| D10 | Look at Home before pulling to refresh. | Shows the lists you last saw; they update on the first refresh. |
| D11 | Backup & Restore → restore a backup taken BEFORE the upgrade. | Restores cleanly. |

---

## F. Android native rebuild

| # | Do in the app | Expect |
|---|---|---|
| F1 | Rebuild the Android app, then Settings → Image Cache → **Scan**. | Completes with no errors. With image-cache diagnostics enabled, the log shows `pass1 no-new-rows` and a `pass2` line — and no `safety gate` line. |

---

## E. Car + voice — needs a TestFlight / release build

Parked until that build exists.

| # | Do | Expect |
|---|---|---|
| E1 | Force-quit the app. Connect CarPlay / Android Auto. Browse albums from the car without touching the phone. | Albums list and match what the app shows. |
| E2 | In the car: Albums → pick a letter → pick a sub-group → play a track. | Letters and groups populated and in order; the track plays. |
| E3 | In the car: Playlists → open one → play a track from partway down. | Right track, right order. |
| E4 | In the car: Favourites → play a track. | Plays. |
| E5 | Force-quit. Start playback FROM THE CAR. Let it run ~30s. Then open the app on the phone. | Playback continues — does not restart or jump position. |
| E6 | Turn off wifi and mobile data. Force-quit. Connect the car. Browse and play downloaded music. | Downloads are browsable and play. Nothing hangs waiting for the server. |
| E7–E11 | By voice: play a specific song / an album / an artist / a playlist / a genre. | Each plays the right thing. |
| E12 | By voice, a phrase with no category ("play something by …"). | Resolves to something sensible rather than failing. |
| E13 | By voice with the app not running at all. | Cold-starts and plays. |
| E14 | Repeat E1 and E6 on a build upgraded from the old version, with downloads already present. | Both still work; downloads still found. |
