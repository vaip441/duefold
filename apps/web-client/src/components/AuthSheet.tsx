/**
 * The unauthenticated sheet: a measured column on the same plane as the rest of
 * the interface. No card, no shadow, no centred white box.
 */

import type { ReactNode } from 'react';
import { useBrand } from '../branding/useBrand.ts';
import { BrandLogo } from './BrandLogo.tsx';
import { SupportLine } from './SupportLine.tsx';
import { ThemeSelect, type ThemeChoice } from './ThemeSelect.tsx';

export interface AuthSheetProps {
  readonly title: string;
  readonly lead: string;
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}

export function AuthSheet({
  title,
  lead,
  theme,
  onThemeChange,
  children,
  aside,
}: AuthSheetProps): React.ReactElement {
  const { brand } = useBrand();
  const hasCustomBrand = brand?.logoUrl !== null && brand?.logoUrl !== undefined;

  return (
    <div className="df-sheet">
      <header className="df-sheet__header">
        <BrandLogo brand={brand} />
        <ThemeSelect value={theme} onChange={onThemeChange} />
      </header>
      <main className="df-sheet__main">
        <div className="df-sheet__column">
          <h1 className="df-sheet__title">{title}</h1>
          <p className="df-sheet__lead">{lead}</p>
          {children}
          {aside === undefined ? null : <div className="df-sheet__aside">{aside}</div>}
        </div>
      </main>
      <footer className="df-sheet__footer">
        <SupportLine contact={brand?.supportContact ?? null} />
        {hasCustomBrand ? <p className="df-sheet__powered">Powered by Duefold</p> : null}
      </footer>
    </div>
  );
}
