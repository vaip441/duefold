/**
 * Application root.
 *
 * Routing is deliberately minimal: three states resolved from the server's
 * session bootstrap plus the path. A router library would be an abstraction
 * ahead of a requirement.
 *
 * The shape of this file is the security posture: the client asks the server what
 * it is, and renders accordingly. It never decides for itself that a session
 * exists, and hiding a control is never treated as a permission.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, loadSession } from './api/client.ts';
import { Notice } from './components/Notice.tsx';
import { StatusRegion } from './components/StatusRegion.tsx';
import { useThemeChoice } from './components/ThemeSelect.tsx';
import { translate } from './i18n/translate.ts';
import { MemberSignIn } from './routes/MemberSignIn.tsx';
import { ViewerReadingRoom } from './routes/ViewerReadingRoom.tsx';
import { ViewerSignIn } from './routes/ViewerSignIn.tsx';
import { Workspace } from './routes/Workspace.tsx';

type Bootstrap =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'session'; readonly principal: 'member' | 'viewer' };

type AuthChoice = 'member' | 'viewer';

/** The sign-in surface a viewer landed on, and whether OIDC returned a failure. */
function initialChoice(): AuthChoice {
  return window.location.pathname.startsWith('/read') ? 'viewer' : 'member';
}

function initialFailed(): boolean {
  return new URLSearchParams(window.location.search).get('state') === 'failed';
}

export function App(): React.ReactElement {
  const [theme, setTheme] = useThemeChoice();
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });
  const [choice, setChoice] = useState<AuthChoice>(initialChoice);
  const [signInFailed, setSignInFailed] = useState(initialFailed);
  const authContent = useRef<HTMLDivElement | null>(null);
  const pendingAuthEntry = useRef(false);

  useLayoutEffect(() => {
    if (!pendingAuthEntry.current) return;
    pendingAuthEntry.current = false;
    authContent.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 160,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
    });
  }, [choice]);

  const chooseAuth = (next: AuthChoice): void => {
    if (next === choice) return;
    const node = authContent.current;
    if (node === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setChoice(next);
      return;
    }
    const exit = node.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 100,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      fill: 'forwards',
    });
    void exit.finished.then(() => {
      pendingAuthEntry.current = true;
      setChoice(next);
    });
  };

  const refresh = useCallback((signal?: AbortSignal): void => {
    loadSession(signal).then(
      (session) => {
        setBootstrap(
          session.authenticated
            ? { kind: 'session', principal: session.principal }
            : { kind: 'anonymous' },
        );
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setBootstrap({
          kind:
            error instanceof ApiError && error.failure === 'offline'
              ? 'offline'
              : 'unavailable',
        });
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh]);

  if (bootstrap.kind === 'loading') {
    return (
      <div className="df-sheet">
        <main className="df-sheet__main">
          <div className="df-sheet__column">
            <p className="df-field__help">{translate('app.loading')}</p>
          </div>
        </main>
        <StatusRegion
          message={translate('app.loading')}
          label={translate('shell.status.region')}
        />
      </div>
    );
  }

  if (bootstrap.kind === 'offline' || bootstrap.kind === 'unavailable') {
    const offline = bootstrap.kind === 'offline';
    return (
      <div className="df-sheet">
        <main className="df-sheet__main">
          <div className="df-sheet__column">
            <h1 className="df-sheet__title">
              {translate(offline ? 'app.offline.title' : 'error.unavailable.title')}
            </h1>
            <Notice tone="problem" role="alert">
              {translate(offline ? 'app.offline.body' : 'error.unavailable.body')}
            </Notice>
            <div className="df-sheet__actions" style={{ marginTop: 'var(--space-4)' }}>
              <button
                type="button"
                className="df-button df-button--primary"
                onClick={() => {
                  setBootstrap({ kind: 'loading' });
                  refresh();
                }}
              >
                {translate('app.retry')}
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (bootstrap.kind === 'session') {
    // A viewer and a member get different surfaces, not one surface with hidden
    // controls: the viewer reading room never renders a member affordance at all.
    if (bootstrap.principal === 'viewer')
      return (
        <ViewerReadingRoom
          theme={theme}
          onThemeChange={setTheme}
          onSignedOut={() => {
            setBootstrap({ kind: 'anonymous' });
            setChoice('viewer');
          }}
        />
      );
    return (
      <Workspace
        principal={bootstrap.principal}
        theme={theme}
        onThemeChange={setTheme}
        onSignedOut={() => {
          setBootstrap({ kind: 'anonymous' });
          setChoice('member');
        }}
      />
    );
  }

  if (choice === 'viewer') {
    return (
      <ViewerSignIn
        theme={theme}
        onThemeChange={setTheme}
        contentRef={authContent}
        onChooseMember={() => {
          chooseAuth('member');
        }}
        onAuthenticated={() => {
          setBootstrap({ kind: 'loading' });
          refresh();
        }}
      />
    );
  }

  return (
    <MemberSignIn
      failed={signInFailed}
      theme={theme}
      onThemeChange={setTheme}
      contentRef={authContent}
      onChooseViewer={() => {
        setSignInFailed(false);
        chooseAuth('viewer');
      }}
    />
  );
}
