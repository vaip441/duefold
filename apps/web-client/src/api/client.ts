/**
 * The browser's API surface, re-exported from one place.
 *
 * This file was a single 1213-line module covering session, rooms, structure,
 * publication, search, viewer delivery, participants, grants, processing, exports,
 * branding, and uploads. It is now a barrel over five domain modules, so a change
 * to grants does not put export or viewer code in the same diff.
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
  readJson,
  request,
  requireArray,
  requireNumber,
  requireString,
  type ApiFailure,
  type RequestOptions,
} from './transport.ts';

export { loadSession, requestOtp, signOut, verifyOtp, type SessionState } from './auth.ts';

export {
  loadRoomWorkspace,
  loadRooms,
  mutateStructure,
  publicationApply,
  publicationDryRun,
  restoreFromTrash,
  searchRoom,
  type MemberRoom,
  type PublicationChangeKind,
  type PublicationImpact,
  type PublicationItem,
  type RoomAccessSource,
  type RoomState,
  type RoomWorkspace,
  type SearchHit,
  type TrashEntry,
  type WorkingEntry,
} from './rooms.ts';

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
  searchViewerRoom,
  type DownloadLease,
  type DownloadPolicy,
  type InterstitialTarget,
  type PreviewActivity,
  type TextLayer,
  type TextLayerItem,
  type ViewerDocument,
  type ViewerEntry,
  type ViewerRoom,
  type ViewerSearchHit,
} from './viewer.ts';

export {
  applyGrantChange,
  dryRunGrantChange,
  inviteParticipant,
  loadParticipants,
  type GrantChangeAction,
  type GrantChangeRequest,
  type GrantImpact,
  type GrantSource,
  type GrantTargetKind,
  type GranteeKind,
  type Participant,
  type ParticipantGrant,
} from './participants.ts';

export {
  createBrandingUploadIntent,
  createUploadIntent,
  deleteBrandingAsset,
  deleteFailedSource,
  downloadExportOnce,
  finalizeBrandingUpload,
  finalizeUpload,
  generateExport,
  loadBranding,
  loadExports,
  loadProcessingState,
  loadPublicBranding,
  preflightExport,
  retryProcessing,
  updateBranding,
  type BrandingConfiguration,
  type ExportPreflight,
  type ExportPreset,
  type ExportRecord,
  type ExportRequestInput,
  type ProcessingVersion,
  type PublicBranding,
  type UploadIntentResponse,
} from './member-operations.ts';
