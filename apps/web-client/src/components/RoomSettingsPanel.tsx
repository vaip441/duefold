/**
 * The room Settings section. It owns its state through `useRoomSettings`; the room view
 * only chooses whether to offer it.
 */
import { useId } from 'react';
import { translate } from '../i18n/translate.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { Notice } from './Notice.tsx';
import { RoomLifecycleControls } from './RoomLifecycleControls.tsx';
import { RoomPolicyControls } from './RoomPolicyControls.tsx';
import { RoomVisibilityControls } from './RoomVisibilityControls.tsx';

export interface RoomSettingsPanelProps {
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomSettingsPanel({
  section,
  onStatus,
}: RoomSettingsPanelProps): React.ReactElement {
  const headingId = useId();
  const load = section.load;
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('settings.heading')}
    </h2>
  );

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('settings.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('settings.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {/* A stale revision already offers Reload inside the notice. */}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  const { settings } = load.value;
  return (
    <section aria-labelledby={headingId}>
      {heading}
      <RoomVisibilityControls settings={settings} section={section} onStatus={onStatus} />
      <RoomPolicyControls
        key={`policy-${settings.revision}`}
        settings={settings}
        overrideCount={load.value.downloadOverrides.size}
        section={section}
        onStatus={onStatus}
      />
      <RoomLifecycleControls
        key={`lifecycle-${settings.revision}`}
        settings={settings}
        section={section}
        onStatus={onStatus}
      />
    </section>
  );
}
