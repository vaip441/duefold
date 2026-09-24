/**
 * Where the member or viewer is, kept in the address bar.
 *
 * Refresh, Back, and a copied link must return a person to the same room, section, or
 * document, so the location is the URL rather than component state. Paths carry only
 * the opaque ids the server already issued; reaching a path never grants anything,
 * because every view still loads through the server's authorization.
 */

import { useCallback, useEffect, useState } from 'react';

export type MemberLocation =
  | { readonly kind: 'rooms' }
  | { readonly kind: 'administration'; readonly section: string }
  | { readonly kind: 'room'; readonly roomId: string; readonly section: string };

export type ViewerLocation =
  | { readonly kind: 'rooms' }
  | {
      readonly kind: 'room';
      readonly roomId: string;
      readonly documentId: string | null;
      readonly page: number;
    };

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const SECTION = /^[a-z][a-z-]{0,31}$/u;

function segments(pathname: string): readonly string[] {
  return pathname.split('/').filter((part) => part !== '');
}

export function parseMemberLocation(pathname: string): MemberLocation {
  const [first, second, third] = segments(pathname);
  if (first === 'administration')
    return {
      kind: 'administration',
      section: second !== undefined && SECTION.test(second) ? second : 'members',
    };
  if (first === 'rooms' && second !== undefined && OPAQUE_ID.test(second))
    return {
      kind: 'room',
      roomId: second,
      section: third !== undefined && SECTION.test(third) ? third : 'structure',
    };
  return { kind: 'rooms' };
}

export function formatMemberLocation(location: MemberLocation): string {
  switch (location.kind) {
    case 'rooms':
      return '/';
    case 'administration':
      return `/administration/${location.section}`;
    case 'room':
      return location.section === 'structure'
        ? `/rooms/${location.roomId}`
        : `/rooms/${location.roomId}/${location.section}`;
  }
}

export function parseViewerLocation(pathname: string, search: string): ViewerLocation {
  const [first, second, third, fourth] = segments(pathname);
  if (first !== 'rooms' || second === undefined || !OPAQUE_ID.test(second))
    return { kind: 'rooms' };
  const documentId =
    third === 'documents' && fourth !== undefined && OPAQUE_ID.test(fourth) ? fourth : null;
  const page = Number.parseInt(new URLSearchParams(search).get('page') ?? '1', 10);
  return {
    kind: 'room',
    roomId: second,
    documentId,
    page: documentId !== null && Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

export function formatViewerLocation(location: ViewerLocation): string {
  if (location.kind === 'rooms') return '/';
  if (location.documentId === null) return `/rooms/${location.roomId}`;
  const base = `/rooms/${location.roomId}/documents/${location.documentId}`;
  return location.page > 1 ? `${base}?page=${String(location.page)}` : base;
}

export type Navigate<T> = (next: T, mode?: 'push' | 'replace') => void;

/**
 * The current location and a way to move it.
 *
 * `push` is for a destination a person chose, so Back returns them; `replace` is for
 * corrections and page turns, which would otherwise fill the history with every page.
 */
export function useLocation<T>(
  parse: (pathname: string, search: string) => T,
  format: (location: T) => string,
): readonly [T, Navigate<T>] {
  const [location, setLocation] = useState(() =>
    parse(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPop = (): void => {
      setLocation(parse(window.location.pathname, window.location.search));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, [parse]);

  const navigate = useCallback<Navigate<T>>(
    (next, mode = 'push') => {
      const path = format(next);
      if (path !== `${window.location.pathname}${window.location.search}`) {
        if (mode === 'push') window.history.pushState(null, '', path);
        else window.history.replaceState(null, '', path);
      }
      setLocation(next);
    },
    [format],
  );

  return [location, navigate];
}
