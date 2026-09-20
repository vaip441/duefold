import { Popover } from '@base-ui/react/popover';
import { useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';

export interface AccountMenuProps {
  readonly children: ReactNode;
}

/**
 * Account controls stay inline on wide layouts and become an anchored popover on
 * phones. Base UI owns focus return, Escape, outside dismissal, and exit presence;
 * Duefold owns the visual treatment and timing.
 */
export function AccountMenu({ children }: AccountMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <span className="df-account-menu">
      <span className="df-account-menu__inline">{children}</span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="df-account-menu__toggle df-button df-button--quiet">
          {translate('shell.accountMenu')}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="df-account-menu__positioner"
            side="bottom"
            align="end"
            sideOffset={1}
          >
            <Popover.Popup
              className="df-account-menu__panel"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button') !== null) setOpen(false);
              }}
            >
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
