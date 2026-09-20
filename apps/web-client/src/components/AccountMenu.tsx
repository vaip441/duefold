import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';

export interface AccountMenuProps {
  readonly children: ReactNode;
}

/**
 * Account controls stay inline on wide layouts and become one disclosure on
 * phones. The controls exist once in the DOM so labels and form ids remain
 * unique. Exit presence is handled with visibility plus opacity/transform;
 * Escape, outside dismissal, and focus return stay explicit and testable.
 */
export function AccountMenu({ children }: AccountMenuProps): React.ReactElement {
  const narrowQuery = '(max-width: 30rem)';
  const [open, setOpen] = useState(
    () => typeof window === 'undefined' || !window.matchMedia(narrowQuery).matches,
  );
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const query = window.matchMedia(narrowQuery);
    const update = (): void => {
      setOpen(!query.matches);
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!open || !window.matchMedia(narrowQuery).matches) return;
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  return (
    <span ref={root} className="df-account-menu" data-open={open ? 'true' : 'false'}>
      <button
        ref={toggle}
        type="button"
        className="df-account-menu__toggle df-button df-button--quiet"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {translate('shell.accountMenu')}
      </button>
      <span
        id={panelId}
        className="df-account-menu__panel"
        inert={!open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button') !== null) setOpen(false);
        }}
      >
        {children}
      </span>
    </span>
  );
}
