/**
 * The Installation section: settings that apply to every room at once. It owns no state;
 * `useInstallationSettings` does.
 */
import { useId } from 'react';
import { translate } from '../i18n/translate.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { InstallationDownloadControls } from './InstallationDownloadControls.tsx';
import { Notice } from './Notice.tsx';

export function InstallationPanel({
  section,
  onStatus,
}: {
  readonly section: InstallationSettingsSection;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const headingId = useId();
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('installation.heading')}
    </h2>
  );
  const { load } = section;

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('installation.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('installation.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      {heading}
      <InstallationDownloadControls
        key={load.value.revision}
        settings={load.value}
        section={section}
        onStatus={onStatus}
      />
    </section>
  );
}
