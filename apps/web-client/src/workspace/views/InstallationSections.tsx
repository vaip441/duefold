/**
 * The Administration view's own sections. Each owns its state through its hook, so the view
 * only chooses which one is showing.
 */
import { loadInstallationStatus } from '../../api/client.ts';
import { InstallationPanel } from '../../components/InstallationPanel.tsx';
import { StatusPanel } from '../../components/StatusPanel.tsx';
import { useInstallationSettings } from '../useInstallationSettings.ts';
import { useLoad } from '../useLoad.ts';

export function StatusSection(): React.ReactElement {
  const section = useLoad(loadInstallationStatus);
  return <StatusPanel section={section} />;
}

export function InstallationSection({
  onStatus,
}: {
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const section = useInstallationSettings();
  return <InstallationPanel section={section} onStatus={onStatus} />;
}
