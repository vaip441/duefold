/**
 * The Administration view's own sections. Each owns its state through its hook, so the view
 * only chooses which one is showing.
 */
import { loadInstallationStatus } from '../../api/client.ts';
import { StatusPanel } from '../../components/StatusPanel.tsx';
import { useLoad } from '../useLoad.ts';

export function StatusSection(): React.ReactElement {
  const section = useLoad(loadInstallationStatus);
  return <StatusPanel section={section} />;
}
