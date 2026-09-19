/**
 * Theme control: light, dark, system default, and an individual override.
 *
 * The override is a session-scoped choice held in React state and applied to the
 * document element. It is deliberately NOT persisted: `localStorage` and friends
 * must hold nothing for a Duefold session, and a theme
 * preference is not worth carving an exception into that rule. Without an
 * override the CSS `prefers-color-scheme` block follows the system.
 */

import { useEffect, useId, useState } from 'react';
import { translate } from '../i18n/translate.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';

export function useThemeChoice(): readonly [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);
  return [choice, setChoice];
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
