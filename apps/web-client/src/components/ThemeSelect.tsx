/**
 * Theme control: light, dark, system default, and an individual override.
 *
 * The override is non-sensitive presentation state, so light or dark is retained
 * in this browser across visits. Choosing system removes the stored override and
 * lets the CSS `prefers-color-scheme` block follow the operating system.
 */

import { useId, useLayoutEffect, useState } from 'react';
import { translate } from '../i18n/translate.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'duefold.theme';

function storedThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function persistThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be disabled; the in-memory override still works for this visit.
  }
}

export function useThemeChoice(): readonly [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(storedThemeChoice);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);
  return [
    choice,
    (next) => {
      persistThemeChoice(next);
      setChoice(next);
    },
  ];
}

export interface ThemeSelectProps {
  readonly value: ThemeChoice;
  readonly onChange: (choice: ThemeChoice) => void;
}

export function ThemeSelect({ value, onChange }: ThemeSelectProps): React.ReactElement {
  const id = useId();
  return (
    <span className="df-theme">
      <label htmlFor={id}>{translate('app.themeLabel')}</label>
      <select
        id={id}
        className="df-theme__select"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'system' || next === 'light' || next === 'dark') onChange(next);
        }}
      >
        <option value="system">{translate('app.theme.system')}</option>
        <option value="light">{translate('app.theme.light')}</option>
        <option value="dark">{translate('app.theme.dark')}</option>
      </select>
    </span>
  );
}
