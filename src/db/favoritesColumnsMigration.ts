/**
 * The one-time move of the `favorite_*.json` envelopes into columns.
 *
 * The remainder is the ONLY local copy of a starred item the library has no row for, and
 * getting it back needs a `getStarred2` the user may not be able to make. So the envelope
 * is never given up: every row is written, READ BACK, and one that does not verify keeps
 * its gate shut and is read from the envelope exactly as before.
 *
 * That gate is why this cannot lose a favourite whatever it does — and losing one is not
 * a cosmetic list bug: these rows feed Play All, CarPlay, the voice vocabulary and the
 * `__starred__` download. Failing is always the safe direction, so a failure logs and
 * moves on rather than throwing; pinning the migration counter would stall every later
 * migration for a conversion that only removes a parse.
 *
 * Idempotent: a converted row is no longer in the work set, an unconverted one is
 * retried on the next launch.
 */
import { errMessage } from '../utils/errorMessage';

import type { InternalDb } from './client';
import {
  convertFavoriteRow,
  readUnconvertedFavorites,
  STARRED_ENTITIES,
  type StarredEntity,
} from './repository/favorites';

async function convertEntity(
  db: InternalDb,
  entity: StarredEntity,
  log: (message: string) => void,
): Promise<void> {
  const rows = await readUnconvertedFavorites(db, entity);
  if (rows.length === 0) return;
  let converted = 0;
  for (const row of rows) {
    try {
      // Serial: each row is its own atomic batch, and the remainder is user-curated.
      // eslint-disable-next-line no-await-in-loop
      if (await convertFavoriteRow(db, entity, row)) converted++;
    } catch (e) {
      log(`[m40] ${entity} ${row.id} failed — keeping its envelope: ${errMessage(e)}`);
    }
  }
  log(
    `[m40] ${entity}: converted ${converted}/${rows.length}; ` +
      `${rows.length - converted} keep reading json`,
  );
}

/** Move every remainder row's envelope into its columns. See the module docblock. */
export async function migrateFavoritesToColumns(
  db: InternalDb,
  log: (message: string) => void,
): Promise<void> {
  for (const entity of STARRED_ENTITIES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await convertEntity(db, entity, log);
    } catch (e) {
      log(`[m40] ${entity} could not be read — skipped: ${errMessage(e)}`);
    }
  }
}
