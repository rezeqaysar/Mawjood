// theme.ts — light / dark / auto (time-based) theming.
// Module-level store (same pattern as i18n.ts): any component can useTheme()
// and they all stay in sync. Persisted in AsyncStorage.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TextStyle } from 'react-native';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

// ── Design tokens (engine-style, zero-dependency) ─────────────────────
// ONE type scale + spacing + radius for the whole app so every screen
// reads the same. Sizes picked for Arabic-first readability: body 16px
// minimum for anything the user must read, 44–48px touch targets.

export interface TypeToken {
  size: number;
  height: number; // lineHeight
  weight: TextStyle['fontWeight'];
}

export const TYPO: Record<
  'display' | 'title' | 'headline' | 'body' | 'bodyBold' | 'sub' | 'subBold' | 'caption' | 'tiny',
  TypeToken
> = {
  display: { size: 30, height: 38, weight: '800' }, // hero numbers, big headers
  title: { size: 22, height: 29, weight: '800' }, // screen titles, empty states
  headline: { size: 18, height: 25, weight: '700' }, // section headers, card titles
  body: { size: 16, height: 24, weight: '400' }, // chat bubbles, main reading text
  bodyBold: { size: 16, height: 24, weight: '600' },
  sub: { size: 14, height: 20, weight: '400' }, // secondary descriptions
  subBold: { size: 14, height: 20, weight: '600' },
  caption: { size: 12, height: 16, weight: '500' }, // timestamps, hints
  tiny: { size: 11, height: 14, weight: '500' }, // badges, micro-labels
};

/** Spacing scale (px). */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, xxxl: 36 } as const;

/** Corner radius scale (px). */
export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

/** Minimum comfortable touch target (px). */
export const TOUCH = 48;

/** Flatten a type token into a RN text style. */
export function typeStyle(t: TypeToken): { fontSize: number; lineHeight: number; fontWeight: TextStyle['fontWeight'] } {
  return { fontSize: t.size, lineHeight: t.height, fontWeight: t.weight };
}

export interface Palette {
  ink: string; // primary text / dark fills
  ink2: string; // strong text
  text2: string; // secondary text
  text3: string; // tertiary text
  muted: string; // muted text
  faint: string; // placeholder / faint
  faint2: string;
  faint3: string;
  paper: string; // app background / light text on dark fills
  surface: string; // cards
  surface2: string; // pills, secondary surfaces
  input: string; // text inputs
  tint: string; // warm tinted surfaces
  accent: string; // brand orange
  accentDeep: string; // small accent text
  info: string; // blue
  infoSoft: string; // blue tint bg
  success: string; // green
  successSoft: string; // green tint bg
  danger: string; // red
  dangerSoft: string; // red tint bg
  dangerDeep: string; // deep red text
  warn: string; // amber text
  border: string; // default borders / dividers
  borderWarn: string; // amber borders
  borderSuccess: string; // green borders
  overlay: string; // modal dim
  gray: string; // neutral gray
}

const light: Palette = {
  ink: '#2B2118',
  ink2: '#3A2F25',
  text2: '#5C4F42',
  text3: '#6B5D4F',
  muted: '#8A7B6C',
  faint: '#A09485',
  faint2: '#A89880',
  faint3: '#B0A08A',
  paper: '#FAF7F2',
  surface: '#FBF8F2',
  surface2: '#EFE7DC',
  input: '#F4EDE4',
  tint: '#F3E9D2',
  accent: '#B3541E',
  accentDeep: '#8a6d4b',
  info: '#1E5A8A',
  infoSoft: '#E8F4FF',
  success: '#2E7D32',
  successSoft: '#F0F7F0',
  danger: '#B3402E',
  dangerSoft: '#F5D5D5',
  dangerDeep: '#9C4A2F',
  warn: '#7A5C14',
  border: '#E8E0D4',
  borderWarn: '#EAD9A8',
  borderSuccess: '#CBE3CB',
  overlay: 'rgba(43,33,24,0.45)',
  gray: '#8A8A8A',
};

const dark: Palette = {
  ink: '#EAE2D4',
  ink2: '#DFD4C0',
  text2: '#CFC3B2',
  text3: '#B3A693',
  muted: '#97897A',
  faint: '#7E7466',
  faint2: '#847768',
  faint3: '#6E6355',
  paper: '#161210',
  surface: '#231D17',
  surface2: '#2E2620',
  input: '#2A231C',
  tint: '#2C241A',
  accent: '#E8934A',
  accentDeep: '#C99A5B',
  info: '#7FB3E0',
  infoSoft: '#1B2733',
  success: '#7BC98A',
  successSoft: '#1E2B20',
  danger: '#E07A68',
  dangerSoft: '#33201C',
  dangerDeep: '#E08A6E',
  warn: '#E3B85C',
  border: '#38302A',
  borderWarn: '#54432A',
  borderSuccess: '#2E4A33',
  overlay: 'rgba(0,0,0,0.6)',
  gray: '#6E6E6E',
};

const KEY = 'mawjood.theme-mode';
// auto: dark from 19:00 to 07:00, light otherwise
const NIGHT_START = 19;
const NIGHT_END = 7;

let mode: ThemeMode = 'light';
let resolved: ResolvedTheme = 'light';
const listeners = new Set<() => void>();

function isNightNow(): boolean {
  const h = new Date().getHours();
  return h >= NIGHT_START || h < NIGHT_END;
}

function compute(): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return isNightNow() ? 'dark' : 'light';
}

function emit() {
  listeners.forEach((l) => l());
}

/** Re-resolve (e.g. on app foreground) and notify if it flipped. */
export function refreshTheme() {
  const r = compute();
  if (r !== resolved) {
    resolved = r;
    emit();
  }
}

export async function initTheme(): Promise<void> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') mode = v;
  } catch {
    /* keep default */
  }
  resolved = compute();
  emit();
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function getPalette(): Palette {
  return resolved === 'dark' ? dark : light;
}

export async function setThemeMode(m: ThemeMode): Promise<void> {
  mode = m;
  try {
    await AsyncStorage.setItem(KEY, m);
  } catch {
    /* keep in-memory */
  }
  resolved = compute();
  emit();
}

export function cycleThemeMode(): void {
  void setThemeMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'auto' : 'light');
}

export function useTheme() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return {
    mode,
    resolved,
    palette: getPalette(),
    setMode: setThemeMode,
    cycle: cycleThemeMode,
    refresh: refreshTheme,
  };
}

// keep auto mode honest while the app stays open
setInterval(() => {
  if (mode === 'auto') refreshTheme();
}, 60_000);

// load the saved choice as soon as the module is imported
void initTheme();
