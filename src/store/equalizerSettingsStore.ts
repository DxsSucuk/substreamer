/**
 * Persisted equalizer settings — the ACTIVE EQ state (enabled + current band
 * gains + selected preset name). RNQP's native EQ doesn't restore its active
 * state across process death, so we persist it here and re-apply at boot via
 * `playerService.applyEqualizerConfig()`.
 *
 * Preset DEFINITIONS (the 16 built-ins + user-saved customs) are persisted
 * natively by RNQP (`getPresets()` / `saveCustomPreset` / `deleteCustomPreset`),
 * so they are NOT duplicated here.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { EQ_BAND_COUNT, EQ_FLAT_PRESET_NAME } from 'react-native-queue-player';

import { kvStorage } from './persistence';

/** Sentinel preset name shown when the gains don't match any saved preset. */
export const EQ_CUSTOM_PRESET_LABEL = 'Custom';

const flatGains = (): number[] => new Array<number>(EQ_BAND_COUNT).fill(0);

export interface EqualizerSettingsState {
  /** Whether the EQ pipeline is active (off = passthrough, zero cost). */
  enabled: boolean;
  /** Current band gains in dB, one per band (length = EQ_BAND_COUNT). */
  gains: number[];
  /** Selected preset name for display, or `EQ_CUSTOM_PRESET_LABEL` when edited. */
  presetName: string;

  setEnabled: (enabled: boolean) => void;
  setGains: (gains: number[]) => void;
  setBandGain: (index: number, gainDb: number) => void;
  setPresetName: (name: string) => void;
  /** Flat gains + Flat preset (does not toggle `enabled`). */
  resetGains: () => void;
}

const PERSIST_KEY = 'substreamer-equalizer-settings';

export const equalizerSettingsStore = create<EqualizerSettingsState>()(
  persist(
    (set) => ({
      enabled: false,
      gains: flatGains(),
      presetName: EQ_FLAT_PRESET_NAME,

      setEnabled: (enabled) => set({ enabled }),
      setGains: (gains) => set({ gains }),
      setBandGain: (index, gainDb) =>
        set((state) => {
          const next = state.gains.slice();
          next[index] = gainDb;
          return { gains: next };
        }),
      setPresetName: (presetName) => set({ presetName }),
      resetGains: () => set({ gains: flatGains(), presetName: EQ_FLAT_PRESET_NAME }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        gains: state.gains,
        presetName: state.presetName,
      }),
    },
  ),
);
