/**
 * Member sign-in: initiation and the OIDC return path.
 *
 * Members authenticate only through the configured identity provider;
 * there is no member email fallback, so this surface has one
 * action. Initiation is a full navigation to `/api/auth/oidc/begin` rather than a
 * fetch, because the response is a redirect to the provider.
 *
 * The return path renders one neutral failure state. The server collapses every
 * failure class — invalid transaction, provider denial, token exchange failure,
 * invitation required, bootstrap identity not allowed, owner already exists —
 * into a single `?state=failed`, and this surface reveals nothing further. No
 * internal code, reason, or identifier appears.
 */

import type { Ref } from 'react';
import { useState } from 'react';
import { translate } from '../i18n/translate.ts';
import { AuthSheet } from '../components/AuthSheet.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusRegion } from '../components/StatusRegion.tsx';
import type { ThemeChoice } from '../components/ThemeSelect.tsx';
import { OIDC_BEGIN_PATH } from '../api/auth.ts';

export { OIDC_BEGIN_PATH };

export interface MemberSignInProps {
  /** True when the identity provider returned the user without a session. */
  readonly failed: boolean;
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onChooseViewer: () => void;
  readonly contentRef?: Ref<HTMLDivElement> | undefined;
  /** Injected so the flow is testable without navigating the harness away. */
  readonly onBegin?: () => void;
}

export function MemberSignIn({
  failed,
  theme,
  onThemeChange,
  onChooseViewer,
  contentRef,
  onBegin,
}: MemberSignInProps): React.ReactElement {
  const [pending, setPending] = useState(false);
  return (
    <AuthSheet
      title="signIn.member.title"
      lead={translate('signIn.member.lead')}
      theme={theme}
      onThemeChange={onThemeChange}
      contentRef={contentRef}
      aside={
        <button type="button" className="df-textlink" onClick={onChooseViewer}>
          {translate('signIn.viewer.link')}
        </button>
      }
    >
      <div className="df-sheet__form">
        {failed ? (
          <Notice tone="problem" role="alert" title={translate('signIn.member.failed.title')}>
            {translate('signIn.member.failed.body')}
          </Notice>
        ) : null}
        <div className="df-sheet__actions">
          <button
            type="button"
            className="df-button df-button--primary"
            data-busy={pending ? 'true' : 'false'}
            disabled={pending}
            onClick={() => {
              setPending(true);
              if (onBegin !== undefined) onBegin();
              else window.location.assign(OIDC_BEGIN_PATH);
            }}
          >
            {pending ? translate('signIn.member.pending') : translate('signIn.member.action')}
          </button>
        </div>
      </div>
      <StatusRegion
        message={pending ? translate('signIn.member.pending') : ''}
        label={translate('shell.status.region')}
      />
    </AuthSheet>
  );
}
