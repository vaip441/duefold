import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';

export interface AccountMenuProps {
  readonly children: ReactNode;
}

/** Account controls stay inline on wide layouts and use a disclosure on phones. */
export function AccountMenu({ children }: AccountMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
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
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button') !== null) setOpen(false);
        }}
      >
        {children}
      </span>
    </span>
  );
}
