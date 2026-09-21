/**
 * The Installation section's read and its one change. A committed change re-reads the
 * settings, because the revision the next change must send has moved.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  applyInstallationDownload,
  loadInstallationSettings,
  reviewInstallationDownload,
  type DownloadPolicy,
  type InstallationDownloadChange,
  type InstallationDownloadImpact,
  type InstallationSettings,
} from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import { useLoad, type LoadedSection } from './useLoad.ts';

export interface InstallationSettingsSection extends LoadedSection<InstallationSettings> {
  readonly reviewDownload: (
    policy: DownloadPolicy,
  ) => Promise<Outcome<InstallationDownloadImpact>>;
  readonly applyDownload: (
    change: InstallationDownloadChange,
  ) => Promise<PresentedFailure | null>;
}

export function useInstallationSettings(): InstallationSettingsSection {
  const loaded = useLoad(loadInstallationSettings);
  const { reload } = loaded;
  /* Alive across the await, so a change that resolves after the section was left does not
     re-read a section nobody is looking at. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const applyDownload = useCallback(
    async (change: InstallationDownloadChange): Promise<PresentedFailure | null> => {
      const failure = await committed(applyInstallationDownload(change));
      if (failure === null && mounted.current) reload();
      return failure;
    },
    [reload],
  );
  return {
    ...loaded,
    reviewDownload: (policy) => settle(reviewInstallationDownload(policy)),
    applyDownload,
  };
}
