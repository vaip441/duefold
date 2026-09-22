/**
 * In-document find.
 *
 * Find is local to the page's text layer: typing here issues no request, so what
 * a viewer searches for never leaves the browser. The match count is announced
 * through the surface's live region rather than only shown, and match navigation
 * is ordinary buttons so the whole control is keyboard-operable.
 */

import { useId } from 'react';
import { translate } from '../i18n/translate.ts';

export interface FindBarProps {
  readonly query: string;
  readonly matchCount: number;
  readonly currentMatch: number | null;
  readonly disabled: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClear: () => void;
}

export function FindBar({
  query,
  matchCount,
  currentMatch,
  disabled,
  onQueryChange,
  onNext,
  onPrevious,
  onClear,
}: FindBarProps): React.ReactElement {
  const fieldId = useId();
  const helpId = useId();
  const active = query.trim() !== '';

  return (
    <section className="df-find" aria-label={translate('viewer.find.label')}>
      <div className="df-field df-field--inline">
        <label className="df-field__label" htmlFor={fieldId}>
          {translate('viewer.find.label')}
        </label>
        <input
          id={fieldId}
          className="df-field__input"
          type="search"
          value={query}
          disabled={disabled}
          placeholder={translate('viewer.find.placeholder')}
          aria-describedby={helpId}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          }}
        />
        <button
          type="button"
          className="df-button"
          disabled={disabled || !active || matchCount === 0}
          onClick={onPrevious}
        >
          {translate('viewer.find.previous')}
        </button>
        <button
          type="button"
          className="df-button"
          disabled={disabled || !active || matchCount === 0}
          onClick={onNext}
        >
          {translate('viewer.find.next')}
        </button>
        {active ? (
          <button type="button" className="df-button df-button--quiet" onClick={onClear}>
            {translate('viewer.find.clear')}
          </button>
        ) : null}
      </div>
      <p className="df-field__help" id={helpId}>
        {/* Count in words, never colour alone; the live region announces it too. */}
        {!active
          ? null
          : matchCount === 0
            ? translate('viewer.find.none')
            : `${translate('viewer.find.count').replace('{count}', String(matchCount))} ${
                currentMatch === null
                  ? ''
                  : translate('viewer.find.position')
                      .replace('{index}', String(currentMatch + 1))
                      .replace('{count}', String(matchCount))
              }`.trim()}
      </p>
    </section>
  );
}
