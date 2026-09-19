/**
 * A ruled notice band. Not a card: one rule in the state colour, and wording
 * that states the state in words so meaning never rests on colour alone.
 */

import type { ReactNode } from 'react';

export type NoticeTone = 'neutral' | 'action' | 'problem' | 'caution';

const TONE_CLASS: Readonly<Record<NoticeTone, string>> = {
  neutral: '',
  action: ' df-notice--action',
  problem: ' df-notice--problem',
  caution: ' df-notice--caution',
};

export interface NoticeProps {
  readonly tone: NoticeTone;
  readonly title?: string;
  readonly children: ReactNode;
  /** `alert` for a problem the user must act on; otherwise plain content. */
  readonly role?: 'alert' | 'status';
  readonly id?: string;
}

export function Notice({ tone, title, children, role, id }: NoticeProps): React.ReactElement {
  return (
    <p
      className={`df-notice${TONE_CLASS[tone]}`}
      {...(role === undefined ? {} : { role })}
      {...(id === undefined ? {} : { id })}
    >
      {title === undefined ? null : <strong className="df-notice__title">{title}</strong>}
      {children}
    </p>
  );
}
