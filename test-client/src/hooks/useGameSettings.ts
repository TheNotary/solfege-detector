import { useCallback, useSyncExternalStore } from "react";

export interface GameSettings {
  speed: number;
  acceleration: number;
  rootNote: string;
  droneVolume: number;
  showDebug: boolean;
  showHitzoneOffset: boolean;
  audioLatencyMs: number;
  displayLatencyMs: number;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  metronomeOffsetMs: number;
  /**
   * When true, the on-screen waveform and hit-zone visual feedback paths
   * subtract an estimate of the drone+metronome bleed via an adaptive AEC
   * worklet. The captured training audio sent to the backend stays raw
   * either way. Defaults to true.
   */
  feedbackCancellation: boolean;
  /**
   * When true, emit verbose AEC diagnostics to the browser console
   * (calibration result, per-stats reduction in dB, applied delay). Off
   * by default to avoid noise during normal play.
   */
  logAecDetails: boolean;
}

const STORAGE_KEY = "solfege-settings";

const DEFAULTS: GameSettings = {
  speed: 30,
  acceleration: 1.0,
  rootNote: "E3",
  droneVolume: 0.15,
  showDebug: true,
  showHitzoneOffset: true,
  audioLatencyMs: 0,
  displayLatencyMs: 0,
  metronomeEnabled: true,
  metronomeVolume: 0.25,
  metronomeOffsetMs: 0,
  feedbackCancellation: true,
  logAecDetails: false,
};

// ── Singleton store so every hook instance shares the same snapshot ──

let listeners: Array<() => void> = [];
let cachedSnapshot: GameSettings | null = null;

function readFromStorage(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch {
    // corrupt data – fall through to defaults
  }
  return { ...DEFAULTS };
}

function getSnapshot(): GameSettings {
  if (!cachedSnapshot) {
    cachedSnapshot = readFromStorage();
  }
  return cachedSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function emitChange() {
  cachedSnapshot = readFromStorage();
  for (const l of listeners) l();
}

function writeToStorage(next: GameSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  emitChange();
}

// ── Hook ──

export function useGameSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);

  const updateSetting = useCallback(
    <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => {
      const current = getSnapshot();
      writeToStorage({ ...current, [key]: value });
    },
    [],
  );

  const updateSettings = useCallback((partial: Partial<GameSettings>) => {
    const current = getSnapshot();
    writeToStorage({ ...current, ...partial });
  }, []);

  const resetToDefaults = useCallback(() => {
    writeToStorage({ ...DEFAULTS });
  }, []);

  return { settings, updateSetting, updateSettings, resetToDefaults } as const;
}

export { DEFAULTS as GAME_SETTINGS_DEFAULTS };
