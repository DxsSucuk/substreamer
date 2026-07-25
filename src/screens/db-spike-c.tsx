/**
 * DEV-only Spike C — the UI model proof for the persistence rebuild.
 *
 * Seeds a large synthetic table (200k rows) in a throwaway op-SQLite DB, then
 * feeds a FlashList 2.x from a KEYSET SLIDING WINDOW (only the loaded rows live
 * in JS, never `Array.from({length: total})`):
 *   - scroll down  → `onEndReached` seeks the next keyset page and appends
 *   - tap a letter → seek to that letter, REPLACE the window, jump to top
 * The "loaded N / total" counter shows memory stays bounded: jumping resets the
 * window instead of holding the whole library. Delete with `dbSpikes.ts`.
 */
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { openSpikeDb, type SpikeDb } from '../db/testing/dbSpikes';
import { useTheme } from '../hooks/useTheme';

interface Row {
  id: number;
  sort_title: string;
  title: string;
}

const PAGE = 100;
const TARGET = 200_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const mapRows = (raw: Array<Record<string, unknown>>): Row[] =>
  raw.map((r) => ({ id: Number(r.id), sort_title: String(r.sort_title), title: String(r.title) }));

export function DbSpikeCScreen() {
  const { colors } = useTheme();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const listRef = useRef<FlashListRef<Row>>(null);
  const dbRef = useRef<SpikeDb | null>(null);
  const cursorRef = useRef<{ sort: string; id: number } | null>(null); // last loaded (forward)
  const firstCursorRef = useRef<{ sort: string; id: number } | null>(null); // first loaded (backward)
  const loadingMoreRef = useRef(false);
  const loadingPrevRef = useRef(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('initialising…');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = openSpikeDb('spikeC.db', setStatus);
      if (!db) {
        setStatus('op-SQLite unavailable — rebuild the dev client first.');
        return;
      }
      dbRef.current = db;
      db.executeSync('PRAGMA journal_mode = WAL');
      db.executeSync('PRAGMA synchronous = NORMAL');
      db.executeSync('PRAGMA temp_store = MEMORY');
      db.executeSync('CREATE TABLE IF NOT EXISTS s (id INTEGER PRIMARY KEY, sort_title TEXT, title TEXT)');
      db.executeSync('CREATE INDEX IF NOT EXISTS idx_s_sort ON s (sort_title, id)');

      const existing = Number(db.executeSync('SELECT COUNT(*) AS n FROM s').rows[0]?.n ?? 0);
      if (existing < TARGET) {
        for (let i = existing; i < TARGET; i += 1000) {
          if (cancelled) return;
          const cmds: Array<[string, unknown[]]> = [];
          for (let j = i; j < Math.min(i + 1000, TARGET); j++) {
            const letter = LETTERS[j % 26];
            const title = `${letter}${String(j).padStart(6, '0')} synthetic`;
            cmds.push(['INSERT INTO s (id, sort_title, title) VALUES (?, ?, ?)', [j, title.toLowerCase(), title]]);
          }
          await db.executeBatch(cmds);
          if (i % 20000 === 0) setStatus(`seeding ${i.toLocaleString()} / ${TARGET.toLocaleString()}…`);
        }
      }
      if (cancelled) return;

      const first = mapRows(
        db.executeSync(`SELECT id, sort_title, title FROM s ORDER BY sort_title, id LIMIT ${PAGE}`).rows,
      );
      cursorRef.current = first.length ? { sort: first[first.length - 1].sort_title, id: first[first.length - 1].id } : null;
      firstCursorRef.current = first.length ? { sort: first[0].sort_title, id: first[0].id } : null;
      setRows(first);
      setReady(true);
      setStatus(`${TARGET.toLocaleString()} rows · keyset window ${PAGE}/page`);
    })();
    return () => {
      cancelled = true;
      try {
        dbRef.current?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const loadMore = useCallback(() => {
    const db = dbRef.current;
    const cur = cursorRef.current;
    if (!db || !cur || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    db.execute(
      `SELECT id, sort_title, title FROM s WHERE (sort_title, id) > (?, ?) ORDER BY sort_title, id LIMIT ${PAGE}`,
      [cur.sort, cur.id],
    )
      .then((res) => {
        const next = mapRows(res.rows);
        if (next.length) {
          cursorRef.current = { sort: next[next.length - 1].sort_title, id: next[next.length - 1].id };
          setRows((prev) => prev.concat(next));
        } else {
          cursorRef.current = null; // end of data
        }
      })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, []);

  // Backward paging: load the page BEFORE the window on scroll-up. FlashList's
  // maintainVisibleContentPosition (New Arch, on by default) keeps the scroll
  // steady as we prepend — this is what makes an A–Z jump scrollable BOTH ways.
  const loadPrevious = useCallback(() => {
    const db = dbRef.current;
    const cur = firstCursorRef.current;
    if (!db || !cur || loadingPrevRef.current) return;
    loadingPrevRef.current = true;
    db.execute(
      `SELECT id, sort_title, title FROM s WHERE (sort_title, id) < (?, ?) ORDER BY sort_title DESC, id DESC LIMIT ${PAGE}`,
      [cur.sort, cur.id],
    )
      .then((res) => {
        const prevAsc = mapRows(res.rows).reverse();
        if (prevAsc.length) {
          firstCursorRef.current = { sort: prevAsc[0].sort_title, id: prevAsc[0].id };
          setRows((prev) => prevAsc.concat(prev));
        } else {
          firstCursorRef.current = null; // reached the beginning
        }
      })
      .finally(() => {
        loadingPrevRef.current = false;
      });
  }, []);

  const seekLetter = useCallback((letter: string) => {
    const db = dbRef.current;
    if (!db) return;
    const page = mapRows(
      db.executeSync(
        `SELECT id, sort_title, title FROM s WHERE sort_title >= ? ORDER BY sort_title, id LIMIT ${PAGE}`,
        [letter.toLowerCase()],
      ).rows,
    );
    cursorRef.current = page.length ? { sort: page[page.length - 1].sort_title, id: page[page.length - 1].id } : null;
    firstCursorRef.current = page.length ? { sort: page[0].sort_title, id: page[0].id } : null;
    setRows(page);
    // scroll to top of the fresh window after the data swap commits
    setTimeout(() => listRef.current?.scrollToIndex({ index: 0, animated: false }), 0);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: Row; index: number }) => (
      <View style={[styles.row, { borderBottomColor: colors.border }]}>
        <Text style={[styles.rowIndex, { color: colors.textSecondary }]}>{index}</Text>
        <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.rowId, { color: colors.textSecondary }]}>#{item.id}</Text>
      </View>
    ),
    [colors],
  );

  return (
    <GradientBackground>
      <View style={[styles.statusBar, { paddingTop: headerHeight + 8, borderBottomColor: colors.border }]}>
        <Text style={[styles.status, { color: colors.textSecondary }]} numberOfLines={1}>
          {status}
        </Text>
        <Text style={[styles.loaded, { color: colors.primary }]}>
          loaded {rows.length.toLocaleString()} / {TARGET.toLocaleString()}
        </Text>
      </View>

      <View style={styles.body}>
        <FlashList
          ref={listRef}
          data={rows}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          onStartReached={loadPrevious}
          onStartReachedThreshold={0.6}
          drawDistance={300}
          contentContainerStyle={styles.listContent}
        />

        {ready && (
          <View style={styles.sidebar}>
            {LETTERS.map((letter) => (
              <Pressable key={letter} onPress={() => seekLetter(letter)} hitSlop={4} style={styles.letterHit}>
                <Text style={[styles.letter, { color: colors.primary }]}>{letter}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      <BottomChrome />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  statusBar: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: 12,
  },
  status: { fontSize: 12, flexShrink: 1 },
  loaded: { fontSize: 12, fontWeight: '600' },
  body: { flex: 1, flexDirection: 'row' },
  listContent: { paddingBottom: 120 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 28,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIndex: { fontSize: 11, width: 52, fontFamily: 'monospace' },
  rowTitle: { fontSize: 15, flex: 1 },
  rowId: { fontSize: 11, fontFamily: 'monospace' },
  sidebar: {
    position: 'absolute',
    right: 2,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  letterHit: { paddingVertical: 1, paddingHorizontal: 4 },
  letter: { fontSize: 11, fontWeight: '700' },
});
