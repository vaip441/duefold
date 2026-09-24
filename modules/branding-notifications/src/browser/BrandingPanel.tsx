/**
 * Branding panel: organization name, accent, sender name, room introduction,
 * support contact, and sanitized raster asset uploads (logo and square-mark).
 *
 * The accent colour is contrast-checked against BOTH theme grounds as the member
 * types, so the reason a colour is refused is visible at the point of choice
 * rather than arriving as a server error after saving. That check mirrors the
 * server's rule and does not replace it: the server validates the same thing and
 * is authoritative.
 *
 * The support contact is rendered on UNAUTHENTICATED surfaces, so the field states
 * its accepted shapes and empty is a first-class value rather than an error. The
 * note states plainly that custom styles, fonts, and scripts are not accepted, so
 * a member does not go looking for a theme editor that deliberately does not exist.
 */

import { useEffect, useId, useState } from 'react';
import { Notice } from '@duefold/web-client/module-api';
import type { PresentedFailure } from '@duefold/web-client/module-api';
import { validateAccent, validateSupportContact } from '@duefold/web-client/module-api';
import { translate } from '@duefold/web-client/module-api';
import type { BrandingAssetKind, BrandingConfiguration } from './api.ts';
import { brandingCopy } from './copy.ts';

export interface BrandingPanelProps {
  readonly configuration: BrandingConfiguration | null;
  readonly loading: boolean;
  /* True when the load FAILED, so neither the loading line nor an empty form
     stands in for a refusal. */
  readonly denied: boolean;
  readonly failure: PresentedFailure | null;
  readonly savePending: boolean;
  readonly onSave: (input: {
    readonly organizationName: string;
    readonly accentColor: string;
    readonly senderDisplayName: string;
    readonly roomIntroduction: string;
    readonly supportContact: string | null;
    readonly expectedRevision: number;
  }) => void;
  readonly onUploadAsset: (assetKind: BrandingAssetKind, file: File) => Promise<void>;
  readonly onDeleteAsset: (assetKind: BrandingAssetKind) => Promise<void>;
  readonly onReload: () => void;
}

export function BrandingPanel({
  configuration,
  loading,
  denied,
  failure,
  savePending,
  onSave,
  onUploadAsset,
  onDeleteAsset,
  onReload,
}: BrandingPanelProps): React.ReactElement {
  const headingId = useId();
  const fieldId = useId();
  const [organizationName, setOrganizationName] = useState('');
  const [accentColor, setAccentColor] = useState('#006b5e');
  const [senderDisplayName, setSenderDisplayName] = useState('');
  const [roomIntroduction, setRoomIntroduction] = useState('');
  const [supportContact, setSupportContact] = useState('');
  const [attempted, setAttempted] = useState(false);

  // Asset states
  const [hasLogo, setHasLogo] = useState(false);
  const [hasSquareMark, setHasSquareMark] = useState(false);
  const [logoVersion, setLogoVersion] = useState(1);
  const [squareVersion, setSquareVersion] = useState(1);
  const [logoUploading, setLogoUploading] = useState(false);
  const [squareUploading, setSquareUploading] = useState(false);
  const [assetFailure, setAssetFailure] = useState<string | null>(null);

  // Fields are seeded from the server's current configuration, and re-seeded when
  // a save returns a new revision so the form never holds a stale revision.
  useEffect(() => {
    if (configuration === null) return;
    setOrganizationName(configuration.organizationName);
    setAccentColor(configuration.accentColor);
    setSenderDisplayName(configuration.senderDisplayName);
    setRoomIntroduction(configuration.roomIntroduction);
    setSupportContact(configuration.supportContact ?? '');
    setHasLogo(configuration.hasLogo);
    setHasSquareMark(configuration.hasSquareMark);
  }, [configuration]);

  const accentProblem = validateAccent(accentColor);
  const contactValid = validateSupportContact(supportContact);
  const nameValid = organizationName.trim() !== '';
  const senderValid = senderDisplayName.trim() !== '';
  const valid = accentProblem === null && contactValid && nameValid && senderValid;

  const handleUpload = async (kind: BrandingAssetKind, file: File) => {
    setAssetFailure(null);
    if (kind === 'logo') setLogoUploading(true);
    else setSquareUploading(true);

    try {
      await onUploadAsset(kind, file);
      if (kind === 'logo') {
        setHasLogo(true);
        setLogoVersion((v) => v + 1);
      } else {
        setHasSquareMark(true);
        setSquareVersion((v) => v + 1);
      }
    } catch {
      setAssetFailure(brandingCopy('upload.failed'));
    } finally {
      if (kind === 'logo') setLogoUploading(false);
      else setSquareUploading(false);
    }
  };

  const handleDelete = async (kind: BrandingAssetKind) => {
    setAssetFailure(null);
    try {
      await onDeleteAsset(kind);
      if (kind === 'logo') setHasLogo(false);
      else setHasSquareMark(false);
    } catch {
      setAssetFailure(brandingCopy('upload.failed'));
    }
  };

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {brandingCopy('heading')}
      </h2>
      <p className="df-field__help">{brandingCopy('note')}</p>

      {failure === null && assetFailure === null ? null : (
        <Notice tone="problem" role="alert">
          {failure?.body ?? assetFailure}{' '}
          {failure?.offerReload ? (
            <button type="button" className="df-textlink" onClick={onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {/* A failed load must not read as loading. `configuration === null` after a
          refusal previously left this section claiming it was still loading
          underneath the error notice, so the operator saw a contradiction and no
          resolution. Failure is terminal until a reload. */}
      {denied ? null : loading || configuration === null ? (
        <p className="df-field__help">{brandingCopy('loading')}</p>
      ) : (
        <form
          className="df-panel__block"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (savePending) return;
            setAttempted(true);
            if (!valid) return;
            onSave({
              organizationName: organizationName.trim(),
              accentColor: accentColor.toLowerCase(),
              senderDisplayName: senderDisplayName.trim(),
              roomIntroduction,
              supportContact: supportContact.trim() === '' ? null : supportContact.trim(),
              expectedRevision: configuration.revision,
            });
          }}
        >
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-org`}>
              {brandingCopy('organizationName')}
            </label>
            <input
              id={`${fieldId}-org`}
              className="df-field__input"
              value={organizationName}
              disabled={savePending}
              aria-invalid={attempted && !nameValid ? 'true' : undefined}
              onChange={(event) => {
                setOrganizationName(event.target.value);
              }}
            />
          </div>

          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-accent`}>
              {brandingCopy('accentColor')}
            </label>
            <input
              id={`${fieldId}-accent`}
              className="df-field__input"
              type="text"
              inputMode="text"
              spellCheck={false}
              value={accentColor}
              disabled={savePending}
              aria-invalid={accentProblem !== null ? 'true' : undefined}
              aria-describedby={
                accentProblem === null ? `${fieldId}-accent-help` : `${fieldId}-accent-error`
              }
              onChange={(event) => {
                setAccentColor(event.target.value);
              }}
            />
            <p className="df-field__help" id={`${fieldId}-accent-help`}>
              {brandingCopy('accentColor.help')}
            </p>
            {accentProblem === null ? null : (
              <p className="df-field__error" id={`${fieldId}-accent-error`} role="alert">
                {brandingCopy(
                  accentProblem === 'contrast' ? 'accentColor.contrast' : 'accentColor.invalid',
                )}
              </p>
            )}
          </div>

          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-sender`}>
              {brandingCopy('senderDisplayName')}
            </label>
            <input
              id={`${fieldId}-sender`}
              className="df-field__input"
              value={senderDisplayName}
              disabled={savePending}
              aria-invalid={attempted && !senderValid ? 'true' : undefined}
              aria-describedby={`${fieldId}-sender-help`}
              onChange={(event) => {
                setSenderDisplayName(event.target.value);
              }}
            />
            <p className="df-field__help" id={`${fieldId}-sender-help`}>
              {brandingCopy('senderDisplayName.help')}
            </p>
          </div>

          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-intro`}>
              {brandingCopy('roomIntroduction')}
            </label>
            <textarea
              id={`${fieldId}-intro`}
              className="df-field__input df-field__input--area"
              rows={4}
              value={roomIntroduction}
              disabled={savePending}
              aria-describedby={`${fieldId}-intro-help`}
              onChange={(event) => {
                setRoomIntroduction(event.target.value);
              }}
            />
            <p className="df-field__help" id={`${fieldId}-intro-help`}>
              {brandingCopy('roomIntroduction.help')}
            </p>
          </div>

          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-support`}>
              {brandingCopy('supportContact')}
            </label>
            <input
              id={`${fieldId}-support`}
              className="df-field__input"
              value={supportContact}
              disabled={savePending}
              spellCheck={false}
              aria-invalid={!contactValid ? 'true' : undefined}
              aria-describedby={
                contactValid ? `${fieldId}-support-help` : `${fieldId}-support-error`
              }
              onChange={(event) => {
                setSupportContact(event.target.value);
              }}
            />
            <p className="df-field__help" id={`${fieldId}-support-help`}>
              {brandingCopy('supportContact.help')}
            </p>
            {contactValid ? null : (
              <p className="df-field__error" id={`${fieldId}-support-error`} role="alert">
                {brandingCopy('supportContact.invalid')}
              </p>
            )}
          </div>

          {/* Logo Upload & Preview */}
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-logo`}>
              {brandingCopy('logo')}
            </label>
            <p className="df-field__help">{brandingCopy('logo.help')}</p>
            {hasLogo ? (
              <div className="df-brand-asset-preview">
                <img
                  src={`/api/branding/assets/logo?v=${logoVersion}`}
                  alt={brandingCopy('logo')}
                  className="df-brand-asset-preview__image"
                />
                <button
                  type="button"
                  className="df-button df-button--quiet"
                  disabled={logoUploading || savePending}
                  onClick={() => {
                    void handleDelete('logo');
                  }}
                >
                  {brandingCopy('logo.remove')}
                </button>
              </div>
            ) : null}
            <input
              id={`${fieldId}-logo`}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={logoUploading || savePending}
              className="df-field__input df-field__input--file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload('logo', file);
              }}
            />
            {logoUploading ? (
              <p className="df-field__help">{brandingCopy('upload.pending')}</p>
            ) : null}
          </div>

          {/* Square Mark (Favicon) Upload & Preview */}
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-square`}>
              {brandingCopy('squareMark')}
            </label>
            <p className="df-field__help">{brandingCopy('squareMark.help')}</p>
            {hasSquareMark ? (
              <div className="df-brand-asset-preview">
                <img
                  src={`/api/branding/assets/square-mark?v=${squareVersion}`}
                  alt={brandingCopy('squareMark')}
                  className="df-brand-asset-preview__image df-brand-asset-preview__image--square"
                />
                <button
                  type="button"
                  className="df-button df-button--quiet"
                  disabled={squareUploading || savePending}
                  onClick={() => {
                    void handleDelete('square-mark');
                  }}
                >
                  {brandingCopy('squareMark.remove')}
                </button>
              </div>
            ) : null}
            <input
              id={`${fieldId}-square`}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={squareUploading || savePending}
              className="df-field__input df-field__input--file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload('square-mark', file);
              }}
            />
            {squareUploading ? (
              <p className="df-field__help">{brandingCopy('upload.pending')}</p>
            ) : null}
          </div>

          <div className="df-panel__actions">
            <button
              type="submit"
              className="df-button df-button--primary"
              data-busy={savePending ? 'true' : 'false'}
              disabled={savePending}
            >
              {savePending ? brandingCopy('save.pending') : brandingCopy('save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
