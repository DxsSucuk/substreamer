import { StyleSheet } from 'react-native';

export const settingsStyles = StyleSheet.create({
  // Layout
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },

  // Cards
  card: { borderRadius: 12, overflow: 'hidden' },
  cardPadded: { padding: 16 },

  // Info rows
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: { fontSize: 16, flex: 1 },
  infoValue: { fontSize: 16, fontWeight: '500', marginLeft: 12 },

  // In-card navigation rows
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  navRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navRowText: { fontSize: 16, fontWeight: '600' },

  // Action buttons — full-width outlined pressables used for destructive or
  // standalone actions at the bottom of a settings card (log out, clear cache,
  // force resync, etc.). Border color is supplied at the call site: use
  // `colors.red` for destructive actions, `colors.border` for neutral ones.
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },

  // Action-button row — pair of side-by-side pressables (primary + secondary).
  // Used by Back Up / Restore and Library resync / Cancel-or-Resume. Call
  // sites supply background/border/text color via inline styles.
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  actionRowButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 44,
    borderRadius: 10,
  },
  actionRowButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  /** Small explanatory text that follows an action button. */
  sectionHint: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    marginHorizontal: 4,
  },

  // Interaction states
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },

  // Bottom sheet chrome
  sheetBackdrop: { flex: 1, backgroundColor: 'transparent' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 12,
    paddingHorizontal: 16,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 2, paddingHorizontal: 4 },
  sheetHint: { fontSize: 14, fontWeight: '400', marginBottom: 12, paddingHorizontal: 4 },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  sheetOptionLabel: { fontSize: 16, fontWeight: '500' },

  // Small "this won't work offline" notice — icon + hint text, sits below
  // an action row. Used by the OfflineNotice component.
  offlineNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  offlineNoticeText: {
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },

  // Filter pill (cache browsers)
  filterContainer: { paddingVertical: 8 },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    height: 38,
    paddingHorizontal: 10,
  },
  filterIcon: { marginRight: 6 },
  filterInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
});
