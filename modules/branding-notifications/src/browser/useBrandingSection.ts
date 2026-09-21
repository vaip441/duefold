/**
 * Branding section state.
 *
 * Moved here from the application's shared section hook so an omitted module
 * leaves no state machine, no request path, and no copy behind. The one rule it
 * preserves: a failed load becomes `denied`, never a blank form. Rendering an
 * empty form for a refusal tells a Manager the configuration is unset when in
 * fact it was withheld.
 */

import { useCallback, useState } from 'react';
import { presentFailure, type PresentedFailure } from '@duefold/web-client/module-api';
import { planParts } from '@duefold/web-client/module-api';
import { transferParts } from '@duefold/web-client/module-api';
import {
  createBrandingUploadIntent,
  deleteBrandingAsset,
  finalizeBrandingUpload,
  loadBranding,
  updateBranding,
  type BrandingAssetKind,
  type BrandingConfiguration,
  type BrandingUpdate,
} from './api.ts';

export interface BrandingSection {
  readonly configuration: BrandingConfiguration | null;
  readonly loading: boolean;
  readonly denied: boolean;
  readonly failure: PresentedFailure | null;
  readonly saving: boolean;
  readonly refresh: (roomId: string) => void;
  readonly save: (input: BrandingUpdate) => void;
  readonly uploadAsset: (assetKind: BrandingAssetKind, file: File) => Promise<void>;
  readonly deleteAsset: (roomId: string, assetKind: BrandingAssetKind) => Promise<void>;
}

export function useBrandingSection(handlers: {
  readonly onSaved: () => void;
}): BrandingSection {
  const [configuration, setConfiguration] = useState<BrandingConfiguration | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback((roomId: string): void => {
    setLoading(true);
    setFailure(null);
    loadBranding(roomId).then(
      (value) => {
        setLoading(false);
        setConfiguration(value);
      },
      (error: unknown) => {
        setLoading(false);
        setFailure(presentFailure(error));
      },
    );
  }, []);

  return {
    configuration,
    loading,
    // A refusal is terminal until a reload; it must not read as still loading.
    denied: failure !== null,
    failure,
    saving,
    refresh,
    save: (input) => {
      setSaving(true);
      setFailure(null);
      updateBranding(input).then(
        (value) => {
          setSaving(false);
          setConfiguration(value);
          handlers.onSaved();
        },
        (error: unknown) => {
          setSaving(false);
          setFailure(presentFailure(error));
        },
      );
    },
    uploadAsset: async (assetKind, file) => {
      const plan = planParts(file.size);
      const mediaType =
        file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png';
      const intent = await createBrandingUploadIntent({
        assetKind,
        mediaType,
        size: file.size,
        parts: plan,
      });
      const controller = new AbortController();
      const parts = await transferParts({
        file,
        intent,
        plan,
        signal: controller.signal,
        onProgress: () => undefined,
      });
      await finalizeBrandingUpload({
        intentId: intent.intentId,
        uploadId: intent.uploadId,
        parts,
      });
    },
    deleteAsset: async (roomId, assetKind) => {
      await deleteBrandingAsset({ roomId, assetKind });
    },
  };
}
