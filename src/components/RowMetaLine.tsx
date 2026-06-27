import Ionicons from "@react-native-vector-icons/ionicons/static";
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { DownloadedIcon } from './DownloadedIcon';
import { CompactRatingBadge } from './StarRating';
import { useTheme } from '../hooks/useTheme';

/**
 * Compact rating glyph: filled star icon (12) + 3px gap + single digit
 * (~7px tabular-nums) + ~6px breathing for font variance. Matches the
 * `★ 4` review-site convention used by IMDB / Goodreads / Plexamp /
 * foobar2000 in compact list contexts. Detail views (set-rating sheet,
 * album-details modal, etc.) keep the full 5-star strip via
 * `StarRatingDisplay`.
 */
export const RATING_SLOT_WIDTH = 28;
/** 14px icon (heart, downloaded badge) + 4px on each side. */
export const ICON_SLOT_WIDTH = 22;
/**
 * Just enough text room for the bounded duration formats. Two widths,
 * picked at render time from `durationFontSize`:
 *
 *   - **48px** (default, 12px font) for the sub-line meta in AlbumRow /
 *     PlaylistRow / SongRow, which show `formatCompactDuration` up to
 *     "23h 59m" (7 chars).
 *   - **40px** (14px font) for the row-level trailing block in TrackRow /
 *     QueueItemRow, which only ever show `formatTrackDuration` up to
 *     "99:59" (5 chars). The narrower slot removes the dead space to the
 *     left of the time text inside the slot, freeing horizontal room for
 *     the title column.
 *
 * The clock icon that used to live in this slot was dropped to widen the
 * title column on song/track rows.
 */
export const DURATION_SLOT_WIDTH = 48;
const DURATION_SLOT_WIDTH_TRACK = 40;

type SlotKey = 'rating' | 'heart' | 'download' | 'duration';

type DownloadIndicator = 'complete' | 'partial' | 'none';

export interface RowMetaLineProps {
  /**
   * Inner JSX for the flex:1 leading slot (e.g. icon + count text).
   * The wrapper handles `flex:1, minWidth:0, flexDirection:'row',
   * alignItems:'center'` so callers don't repeat the right-shrink boilerplate.
   * Omit when the row uses RowMetaLine as a row-level trailing block.
   */
  leading?: React.ReactNode;

  /**
   * Which fixed-width slots to reserve for this row TYPE. Reserved means
   * the slot's width is held even when the value is absent on a given row,
   * keeping cross-row alignment. A slot omitted here doesn't render at all.
   *
   * Canonical visual order is `rating | download | heart | duration`,
   * regardless of the order keys appear in this prop.
   */
  slots: ReadonlyArray<SlotKey>;

  /** 0 / undefined → empty slot. */
  rating?: number;
  /** Renders a heart icon when true. */
  starred?: boolean;
  /** Mutually-exclusive download state. */
  downloadStatus?: DownloadIndicator;
  /** Pre-formatted duration text (formatter chosen by the caller). */
  durationText?: string;
  /**
   * Override colour for the duration text — used by TrackRow / QueueItemRow
   * when the row represents the currently-playing track. Defaults to
   * `colors.textSecondary`.
   */
  durationColor?: string;
  /**
   * Override font size for the duration text. Defaults to 12 (matches the
   * sub-line meta in AlbumRow/PlaylistRow/SongRow). Pass 14 for the
   * row-level trailing block in TrackRow/QueueItemRow to match their
   * existing sizing.
   */
  durationFontSize?: number;
}

export function RowMetaLine(props: RowMetaLineProps) {
  const {
    leading,
    slots,
    rating = 0,
    starred = false,
    downloadStatus = 'none',
    durationText,
    durationColor,
    durationFontSize = 12,
  } = props;
  const { colors } = useTheme();
  const { t } = useTranslation();

  const showRating = slots.includes('rating');
  const showHeart = slots.includes('heart');
  const showDownload = slots.includes('download');
  const showDuration = slots.includes('duration');

  const downloadIcon =
    downloadStatus === 'complete' ? (
      <DownloadedIcon size={14} circleColor={colors.primary} arrowColor="#fff" />
    ) : downloadStatus === 'partial' ? (
      <DownloadedIcon size={14} circleColor={colors.partialDownload} arrowColor="#fff" />
    ) : null;

  // TODO(rtl): `textAlign: 'right'` and the per-slot fixed widths don't
  // auto-flip under `I18nManager.isRTL`. Substreamer doesn't ship an RTL
  // locale today; revisit if/when we do.
  return (
    <View style={styles.row}>
      {leading !== undefined ? (
        <View style={styles.leading} testID="rowmetaline-leading">{leading}</View>
      ) : null}
      {showRating ? (
        <View style={styles.ratingSlot} testID="rowmetaline-slot-rating">
          {rating > 0 ? (
            <View
              accessible
              accessibilityLabel={t('a11y.rating', {
                rating,
                defaultValue: 'Rating {{rating}} of 5',
              })}
            >
              <CompactRatingBadge
                rating={rating}
                size={12}
                iconColor={colors.primary}
                textColor={colors.textSecondary}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {showDownload ? (
        <View style={styles.iconSlot} testID="rowmetaline-slot-download">
          {downloadIcon ? (
            <View
              accessible
              accessibilityLabel={t(
                downloadStatus === 'partial'
                  ? 'a11y.partiallyDownloaded'
                  : 'a11y.downloaded',
                {
                  defaultValue:
                    downloadStatus === 'partial'
                      ? 'Partially downloaded'
                      : 'Downloaded',
                },
              )}
            >
              {downloadIcon}
            </View>
          ) : null}
        </View>
      ) : null}
      {showHeart ? (
        <View style={styles.iconSlot} testID="rowmetaline-slot-heart">
          {starred ? (
            <Ionicons
              name="heart"
              size={14}
              color={colors.red}
              accessibilityLabel={t('a11y.favourite', { defaultValue: 'Favourite' })}
            />
          ) : null}
        </View>
      ) : null}
      {showDuration ? (
        <View
          style={[
            styles.durationSlot,
            {
              width:
                durationFontSize >= 14
                  ? DURATION_SLOT_WIDTH_TRACK
                  : DURATION_SLOT_WIDTH,
            },
          ]}
          testID="rowmetaline-slot-duration"
        >
          {durationText ? (
            <Text
              style={[
                styles.durationText,
                { fontSize: durationFontSize, color: durationColor ?? colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {durationText}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  leading: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  ratingSlot: {
    width: RATING_SLOT_WIDTH,
    marginLeft: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  iconSlot: {
    width: ICON_SLOT_WIDTH,
    marginLeft: 6,
    // Right-align the icon inside its slot so the trailing icon's right
    // edge matches the right edge of any sibling block (e.g. the
    // duration slot). Default flexDirection is column; `alignItems`
    // controls the cross axis = horizontal.
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  durationSlot: {
    // Width is set inline based on durationFontSize so TrackRow /
    // QueueItemRow get the narrower 40px slot. See DURATION_SLOT_WIDTH /
    // DURATION_SLOT_WIDTH_TRACK doc above.
    marginLeft: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  durationText: {
    // `flex: 1` + `textAlign: 'right'` pins the value to the slot's right
    // edge across rows regardless of content width. Combined with
    // `tabular-nums`, "1:23" and "12:34" still line up neatly.
    flex: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
