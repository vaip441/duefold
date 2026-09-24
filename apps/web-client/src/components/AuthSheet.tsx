/**
 * The unauthenticated sheet: a measured column on the same plane as the rest of
 * the interface. No card, no shadow, no centred white box.
 */

import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { useBrand } from '../branding/useBrand.ts';
import { usePageTitle } from '../branding/usePageTitle.ts';
import { BrandLogo, isOrganizationBrand } from './BrandLogo.tsx';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { SupportLine } from './SupportLine.tsx';
import { ThemeSelect, type ThemeChoice } from './ThemeSelect.tsx';

export interface AuthSheetProps {
  /** A fixed heading, never free text, because it also becomes the browser title. */
  readonly title: MessageKey;
  readonly lead: string;
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
  /** Lets the route coordinate a task-to-task crossfade without moving the shell. */
  readonly contentRef?: Ref<HTMLDivElement> | undefined;
  /** Changes after an in-place authentication task change, never on first paint. */
  readonly motionKey?: string;
}

export function AuthSheet({
  title,
  lead,
  theme,
  onThemeChange,
  children,
  aside,
  contentRef,
  motionKey,
}: AuthSheetProps): React.ReactElement {
  const { brand } = useBrand();
  usePageTitle(title);
  const column = useRef<HTMLDivElement | null>(null);
  const previousMotionKey = useRef(motionKey);
  const hasCustomBrand = isOrganizationBrand(brand);
  const supportContact = brand?.supportContact ?? null;

  useLayoutEffect(() => {
    if (previousMotionKey.current === motionKey) return;
    previousMotionKey.current = motionKey;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    column.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 160,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
    });
  }, [motionKey]);

  const setColumnRef = (node: HTMLDivElement | null): void => {
    column.current = node;
    if (typeof contentRef === 'function') contentRef(node);
    else if (contentRef !== undefined && contentRef !== null) contentRef.current = node;
  };

  return (
    <div className="df-sheet">
      <header className="df-sheet__header">
        <BrandLogo brand={brand} />
        <ThemeSelect value={theme} onChange={onThemeChange} />
      </header>
      <main className="df-sheet__main">
        <div className="df-sheet__column" ref={setColumnRef}>
          <h1 className="df-sheet__title">{translate(title)}</h1>
          <p className="df-sheet__lead">{lead}</p>
          {children}
          {aside === undefined ? null : <div className="df-sheet__aside">{aside}</div>}
        </div>
      </main>
      {supportContact === null && !hasCustomBrand ? null : (
        <footer className="df-sheet__footer">
          <SupportLine contact={supportContact} />
          {hasCustomBrand ? (
            <p className="df-sheet__powered">{translate('app.poweredBy')}</p>
          ) : null}
        </footer>
      )}
    </div>
  );
}
