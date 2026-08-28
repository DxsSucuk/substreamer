# Paging bugs in the empty-query `search3` paths

Found while building a Subsonic client against a MiniMediaSonicServer instance with ~214,000
albums. Both issues below come from the same root cause, but they show up as two different
symptoms, so they're written up separately.

All line references are to
`MiniMediaSonicServer.Application/Repositories/SearchSyncRepository.cs`.

## The underlying cause

`offset` is used as a filter on the `record_id` column rather than as "skip this many rows":

```sql
where al.record_id >= @offset
  and al.record_id <= @offset + @count
```

There is no `LIMIT`, no `OFFSET` and no `ORDER BY`. Those two things are only equivalent if
record_ids start at 0 and never have gaps.

The same three-line `WHERE` appears in all three empty-query paths:

- artists — line 41
- albums — line 97
- tracks — line 193

`getAlbumList2` is **not** affected. `AlbumRepository.cs:59-71` uses a real `LIMIT` over a dense
rank column, which is why that endpoint pages cleanly against the same library.

---

## Issue 1 — every page after the first returns one row too many, and repeats a row

### Symptom

A client asks for 1000 albums starting at offset 0 and gets 1000 back. It asks for the next 1000
starting at offset 1000 and gets **1001** back — and the first album in that batch is the same
album that ended the previous batch. This happens at every page boundary, on every page.

Observed on 426 of 428 pages during a full library sync.

### Cause

The range `record_id >= 1000 AND record_id <= 2000` is inclusive at both ends, so it spans 1001
ids, not 1000. And because the previous page's range ended *at* id 1000, that row is sent twice.

(The first page returns exactly 1000 rather than 1001 only because `record_id` starts at 1, so
there is no row 0 to include.)

### Suggested fix

Make the upper bound exclusive:

```sql
where al.record_id >= @offset
  and al.record_id < @offset + @count
```

Or better, use real paging — see Issue 2, which the same change fixes.

---

## Issue 2 — libraries with gaps in `record_id` page badly

### Symptom

On a library where rows have been deleted over time, so record_ids have holes in them, paging goes
wrong. What the client sees depends on how the client is written:

- A client that advances its offset by **how many rows came back** barely moves forward, and keeps
  re-reading roughly the same albums. The sync never terminates.
- A client that advances by **how many it asked for** — the correct behaviour — sees a page shorter
  than it requested, correctly reads that as "end of results", and stops early. The library looks
  smaller than it really is.

Neither client is doing anything wrong; both get a bad result.

### Cause

The window moves by a fixed number of **ids**, not a fixed number of **rows**. A request for 1000
starting at offset 5000 returns however many rows happen to live in ids 5000–6000 — which could be
1000, or 40, or none at all, depending on where the holes fall.

A library with no deletions hides this completely, which is likely why it hasn't surfaced before.

### Suggested fix

Use standard SQL paging:

```sql
where ...
order by al.record_id
limit @count
offset @offset
```

A page then always contains exactly `@count` rows until the genuine end of the results, regardless
of gaps — and `LIMIT` also caps the row count, so this fixes Issue 1 at the same time.

---

## Why this matters for clients

The Subsonic API exposes no total count, so the only way a client can know it has reached the end
of a paged enumeration is that a page came back shorter than the count it asked for. That signal
only works if a full page always means "there is more". Both issues above break it in a way the
client cannot detect or work around.

For reference, this is how the other implementations handle the same endpoint: Navidrome and gonic
use SQL `LIMIT`/`OFFSET`; Airsonic and Airsonic-Advanced use a Lucene loop bounded by `count`;
Nextcloud Music uses `LIMIT`/`OFFSET`. All of them return at most `count` rows, and an empty result
past the end.
