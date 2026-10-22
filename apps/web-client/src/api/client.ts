/**
 * The browser's API surface, re-exported from one place.
 *
 * This file was a single 1213-line module covering session, rooms, structure,
 * publication, search, viewer delivery, participants, grants, processing, exports,
 * branding, and uploads. It is now a barrel over domain modules, so a change to
 * grants does not put export or viewer code in the same diff.
 *
 * Branding is deliberately ABSENT. Its requests moved into the optional module
 * that owns them, because a branding request path in this barrel would reach the
 * bundle of an installation that omitted the module.
 *
 * The properties that made the original file worth reading are preserved, and they
 * live in transport.ts where every request passes through them:
 *
 * - CSRF is wired once, not per form. Every mutation echoes the
 *   `__Host-duefold_csrf` cookie in `x-duefold-csrf`.
 * - Nothing persists. No token, session value, or protected content is written to
 *   localStorage, sessionStorage, IndexedDB, a service worker, or a cache (8.3).
 * - The browser is never the authorization boundary. These helpers report what the
 *   server decided; no client-side check substitutes for it.
 * - Failure classes carry no server detail, and `conflict` stays distinct from
 *   `unavailable` so a stale revision is never silently retried over a colleague's
 *   change.
 */

export {
  ApiError,
  isRecord,
  json,
  requireBoolean,
  requireNumber,
  requireString,
} from './transport.ts';

export { OIDC_BEGIN_PATH, loadSession, requestOtp, signOut, verifyOtp } from './auth.ts';

export {
  createFolder,
  createRoom,
  loadRoom,
  loadRoomWorkspace,
  loadRooms,
  mutateStructure,
  publicationApply,
  publicationDryRun,
  restoreFromTrash,
  searchRoom,
  type DocumentEntry,
  type MemberRoom,
  type NewRoom,
  type PublicationChangeKind,
  type PublicationImpact,
  type RoomCursor,
  type RoomState,
  type RoomWorkspace,
  type SearchHit,
  type TrashEntry,
  type WorkingEntry,
} from './rooms.ts';

export {
  applyDefaultExpiry,
  applyRetention,
  applyVisibility,
  cancelPurge,
  CANCEL_PURGE_PHRASE,
  loadRoomSettings,
  reviewDefaultExpiry,
  reviewPurge,
  reviewRetention,
  reviewVisibility,
  schedulePurge,
  setDocumentDownloadPolicy,
  setRoomDownloadPolicy,
  type DefaultExpiryImpact,
  type PurgeImpact,
  type RetentionImpact,
  type ReviewedVisibility,
  type RoomCapabilities,
  type RoomSettings,
  type RoomSettingsView,
  type VisibilityChange,
  type VisibilityImpact,
} from './room-settings.ts';

export {
  beginPreview,
  closePreview,
  createDownloadLease,
  createProtectedPage,
  fetchDownloadRange,
  heartbeatPreview,
  loadTextLayer,
  loadViewerDocument,
  loadViewerRooms,
  loadViewerStructure,
  protectedPageImageUrl,
  resolveInterstitial,
  type DownloadPolicy,
  type InterstitialTarget,
  type TextLayer,
  type TextLayerItem,
  type ViewerDocument,
  type ViewerEntry,
  type ViewerRoom,
} from './viewer.ts';

export {
  loadPreviewDocument,
  loadPreviewRoom,
  loadPreviewTextLayer,
  previewPageImageUrl,
  type PreviewRoom,
} from './room-preview.ts';

export {
  applyGrantChange,
  createCounterparty,
  dryRunGrantChange,
  inviteParticipant,
  loadParticipants,
  placeViewerInCounterparty,
  removeViewerFromCounterparty,
  type Counterparty,
  type GrantChangeAction,
  type GrantImpact,
  type GrantTargetKind,
  type Participant,
  type ParticipantGrant,
  type ParticipantRoster,
} from './participants.ts';

export {
  applyOwnershipTransfer,
  applyRoomAssignments,
  dryRunOwnershipTransfer,
  inviteMember,
  loadMembers,
  revokeMemberInvitation,
  setMemberRole,
  setMemberState,
  type AssignableGlobalRole,
  type GlobalRole,
  type MemberPageCursor,
  type MemberState,
  type MemberSubject,
  type OwnershipTransferImpact,
  type PendingInvitation,
  type ProvisionedMember,
  type RoomAssignment,
  type RoomRole,
} from './administration.ts';

export {
  createUploadIntent,
  deleteFailedSource,
  downloadExportOnce,
  finalizeUpload,
  generateExport,
  loadExports,
  loadProcessingState,
  preflightExport,
  retryProcessing,
  type ExportPage,
  type ExportPreflight,
  type ExportPreset,
  type ExportRecord,
  type ProcessingPage,
  type ProcessingVersion,
  type UploadIntentResponse,
} from './member-operations.ts';

export {
  loadInstallationStatus,
  type CheckObservation,
  type InstallationStatus,
  type ObservationCode,
  type StatusCheck,
} from './status.ts';

export {
  applyInstallationDownload,
  loadInstallationSettings,
  reviewInstallationDownload,
  type InstallationDownloadChange,
  type InstallationDownloadImpact,
  type InstallationSettings,
} from './installation.ts';
