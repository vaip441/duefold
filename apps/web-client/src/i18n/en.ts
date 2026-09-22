/**
 * English message catalogue. English is the only 1.0 locale, but every UI string
 * goes through a key so a later locale is a catalogue addition rather than a
 * source rewrite.
 *
 * Copy discipline for this surface:
 * - No internal code, identifier, stack, correlation id, or object key.
 * - Authentication copy is identical whether or not an address was invited.
 * - No claim that screenshots or browser workarounds can be prevented.
 */

export const messages = {
  'app.name': 'Duefold',
  'app.skipToContent': 'Skip to content',
  'app.themeLabel': 'Appearance',
  'app.theme.system': 'System',
  'app.theme.light': 'Light',
  'app.theme.dark': 'Dark',
  'app.loading': 'Loading',
  'app.offline.title': 'No connection',
  'app.offline.body':
    'Your browser is offline. Duefold will work again once the connection returns.',
  'app.retry': 'Try again',
  'app.support.email': 'Contact support',
  'app.support.url': 'Support',

  'shell.landmark.index': 'Collection',
  'shell.landmark.worktable': 'Worktable',
  'shell.landmark.notes': 'Access notes',
  'shell.landmark.roomFacts': 'Room',
  'shell.index.heading': 'Collection',
  'shell.index.empty': 'No rooms yet.',
  'shell.index.emptyHelp': 'A room appears here once one is created.',
  'shell.index.toggle': 'Collection',
  'shell.index.controls': 'Selecting an entry changes the worktable.',
  'shell.notes.heading': 'Access notes',
  'shell.notes.empty': 'Select an item to see who can read it.',
  'shell.worktable.empty': 'Nothing selected.',
  'shell.worktable.emptyHelp': 'Choose an entry in the collection to begin.',
  /** Worktable heading before a room is open. Names the task, not the product. */
  'shell.worktable.title': 'Rooms',
  'shell.status.region': 'Status',
  'shell.signOut': 'Sign out',
  'shell.signOutEverywhere': 'Sign out everywhere',
  'shell.accountMenu': 'Menu',
  'shell.signOut.pending': 'Signing out…',
  'shell.signOut.failed': 'Sign-out did not complete. Try again.',
  'shell.signedOut': 'You are signed out.',

  'signIn.member.title': 'Sign in',
  'signIn.member.lead': 'Duefold members sign in with the organization’s identity provider.',
  'signIn.member.action': 'Continue to identity provider',
  'signIn.member.pending': 'Redirecting…',
  'signIn.member.failed.title': 'Sign-in did not complete',
  'signIn.member.failed.body':
    'Duefold could not complete sign-in. Start again, and if it keeps failing, ask your Duefold administrator to check your access.',
  'signIn.viewer.link': 'I was invited to read documents',
  'signIn.viewer.title': 'Enter your invited email',
  'signIn.viewer.lead':
    'Duefold sends a one-time code to the exact address you were invited with.',
  'signIn.member.link': 'I am a member of this organization',
  'signIn.email.label': 'Email address',
  'signIn.email.help': 'Use the address your invitation was sent to.',
  'signIn.email.invalid': 'Enter an email address, for example name@example.com.',
  'signIn.email.action': 'Send code',
  'signIn.email.pending': 'Sending…',

  /* Deliberately identical whether or not the address was invited, and phrased
   * so it states nothing an attacker could use. Delivery is asynchronous, so it
   * does not promise an email has already arrived. */
  'otp.sent.title': 'Check your email',
  'otp.sent.body':
    'If this address has access, an eight-digit code is on its way. It expires ten minutes after it is sent.',
  /* Shown as a notice after a fresh request, alongside the lead above. Says the
   * same thing more briefly rather than repeating the lead verbatim. */
  'otp.sent.notice': 'Code requested. Enter it below once it arrives.',
  'otp.code.label': 'Eight-digit code',
  'otp.code.help': 'Enter the code from the email. Digits only.',
  'otp.code.invalidFormat': 'Enter the eight digits from the email.',
  'otp.code.action': 'Verify code',
  'otp.code.pending': 'Verifying…',
  'otp.code.rejected':
    'That code did not work. Check the most recent email and enter the code again.',
  'otp.code.expired':
    'This code has expired. Request a new one and use the code from the newest email.',
  'otp.code.exhausted': 'Too many attempts for this code. Request a new one to continue.',
  'otp.resend.action': 'Send a new code',
  'otp.resend.wait': 'You can request a new code in {seconds} seconds.',
  'otp.resend.sent': 'A new code is on its way. The previous code no longer works.',
  'otp.paused': 'Too many code requests. Wait a minute, then try again.',
  'otp.restart': 'Use a different email address',
  'otp.attempts': 'Attempt {current} of {total}.',

  'error.unavailable.title': 'Duefold is not responding',
  'error.unavailable.body': 'The request could not be completed. Wait a moment and try again.',
  'error.denied.title': 'Not available to you',
  'error.denied.body':
    'This address does not have access to that item, or the access has ended.',
  'error.notFound.title': 'Nothing here',
  'error.notFound.body': 'That address does not point to anything you can open.',
  'error.expired.title': 'Your session ended',
  'error.expired.body': 'Sign in again to continue.',
  'error.revoked.title': 'Access has ended',
  'error.revoked.body': 'Your access to this room has been withdrawn.',

  /*
   * Member workspace.
   *
   * Copy rules specific to this surface:
   * - Never state or imply that a working change is live to viewers.
   * - Never imply a trashed name is reserved, or that restore returns
   *   publication or access grants: neither is true.
   * - A global-role room is labelled as reached by role, never as an assignment.
   */
  'rooms.title': 'Rooms',
  'rooms.empty': 'No rooms yet.',
  'rooms.emptyHelp': 'A room appears here once an administrator creates one.',
  'rooms.open': 'Open room',
  'rooms.state.draft': 'Draft',
  'rooms.state.published': 'Published',
  'rooms.state.archived': 'Archived',
  'rooms.state.draft.explain': 'Viewers cannot reach anything in this room.',
  'rooms.state.published.explain': 'Authorized viewers can reach published content.',
  'rooms.state.archived.explain': 'Records remain. Viewers have no content access.',
  'rooms.role.manager': 'Room manager',
  'rooms.role.contributor': 'Contributor',
  'rooms.notes.access': 'Your access: {access}',
  'rooms.access.assignment': 'Assigned to you',
  'rooms.access.globalRole': 'Visible through your organization role',
  'rooms.loading': 'Loading rooms',
  /* A paged register that stopped short. Saying nothing would let a prefix read as
     every room this member can reach. */
  'rooms.partial':
    'This is part of your rooms. Load the rest before concluding which rooms you can reach.',
  'rooms.more': 'Load more rooms',
  'rooms.loadingMore': 'Loading more rooms\u2026',
  'rooms.columns.room': 'Room',
  'rooms.columns.state': 'State',
  'rooms.columns.access': 'Your access',
  'rooms.new': 'New room',
  'rooms.new.title': 'Create a room',
  'rooms.new.explain':
    'The room starts as a draft. Viewers cannot reach anything in it until it is published.',
  'rooms.new.titleLabel': 'Room title',
  'rooms.new.descriptionLabel': 'Description',
  'rooms.new.descriptionHelp':
    'Optional. Plain text that readers see once the room is published.',
  'rooms.new.submit': 'Create room',
  'rooms.new.pending': 'Creating room…',
  'rooms.new.created': 'Room {title} created.',
  'rooms.unavailable': 'This room is not available to you.',
  'rooms.opening': 'Opening room…',
  'rooms.backToRegister': 'Back to all rooms',
  'failure.signInAgain': 'Sign in again',
  'failure.reload': 'Reload',

  'workspace.loading': 'Loading room',
  'workspace.empty': 'This room has no folders or documents yet.',
  'workspace.emptyHelp': 'Create a folder to begin organizing the collection.',
  'workspace.section.structure': 'Working structure',
  'workspace.section.trash': 'Trash',
  'workspace.section.search': 'Search',
  'workspace.columns.name': 'Name',
  'workspace.columns.status': 'Compared with viewers',
  'workspace.columns.order': 'Order',
  'workspace.columns.actions': 'Actions',
  'workspace.steps.label': 'Room preparation',
  'workspace.steps.collection': '1 Collection',
  'workspace.steps.access': '2 Access',
  'workspace.steps.review': '3 Review',
  'workspace.steps.publish': '4 Publish',
  'workspace.live': 'Live to viewers',
  'workspace.notLive': 'Not visible to viewers',
  'workspace.pending': 'Staged, not yet published',
  'workspace.stagedRemoval': 'Staged for removal',
  'workspace.change.add': 'New to viewers when published',
  'workspace.change.remove': 'Removed from viewers when published',
  'workspace.change.rename': 'Renamed since publication',
  'workspace.change.move': 'Moved since publication',
  'workspace.change.reorder': 'Reordered since publication',
  'workspace.change.description': 'Description changed since publication',
  'workspace.change.version': 'New version staged',
  'workspace.change.replace': 'Replaced since publication',
  'workspace.needsVersion': 'No processed version yet, so it cannot be published.',
  'workspace.depthLimit': 'Folders can be five levels deep. This folder is at the limit.',

  'structure.createFolder': 'New folder',
  'structure.createFolder.name': 'Folder name',
  'structure.createFolder.description': 'Description',
  'structure.createFolder.submit': 'Create folder',
  'structure.rename': 'Rename',
  'structure.rename.label': 'New name',
  'structure.rename.submit': 'Save name',
  'structure.move': 'Move',
  'structure.move.destination': 'Destination folder',
  'structure.move.destinationRoot': 'Top level',
  'structure.move.position': 'Position among siblings',
  'structure.move.submit': 'Move here',
  'structure.moveUp': 'Move up',
  'structure.moveDown': 'Move down',
  'structure.reorder.help':
    'Use Move up and Move down, or set a position. Dragging is not required.',
  'structure.reorder.start': 'Reorder collection',
  'structure.reorder.done': 'Finish reordering',
  'structure.reorder.activeHelp':
    'Reorder mode is active. Move items one position at a time, then finish reordering.',
  'structure.manage': 'Manage',
  'structure.manage.help':
    'Open Manage for naming, placement, metadata, download policy, and removal.',
  'structure.downloadPolicy': 'Download policy',
  'structure.stageRemoval': 'Stage removal',
  'structure.stageRemoval.help':
    'Draft-only items move to trash immediately. Published items stay visible to viewers until you publish the removal.',
  'structure.description': 'Edit description',
  'structure.description.submit': 'Save description',
  'structure.title.label': 'Title',
  'structure.cancel': 'Cancel',
  'structure.saving': 'Saving…',
  'structure.stale':
    'Someone else changed this room. Refresh to see the current structure before saving.',
  'structure.refresh': 'Refresh',
  'structure.nameConflict':
    'A folder or document with that name already exists here. Choose a different name.',
  'structure.rejected': 'That change was not accepted. Check the name and try again.',

  'publish.action': 'Review and publish',
  'publish.contributorNote': 'A room manager publishes changes. You can stage them here.',
  'publish.preview.title': 'Publish changes',
  'publish.preview.loading': 'Preparing the change list',
  'publish.preview.none': 'Nothing to publish. Viewers already see the current structure.',
  'publish.preview.count': '{count} changes for viewers.',
  'publish.preview.explain':
    'This is what viewers will see change when you publish. Nothing changes for them until you confirm.',
  'publish.preview.itemPath': 'Path',
  'publish.preview.itemChanges': 'What changes',
  'publish.confirm.label': 'Type {phrase} to publish',
  'publish.confirm.mismatch': 'Type the phrase exactly as shown to continue.',
  'publish.confirm.submit': 'Publish now',
  'publish.pending': 'Publishing…',
  'publish.done': 'Published. Viewers now see the current structure.',
  'publish.failed': 'Publishing did not complete. Nothing was published.',
  'publish.stale':
    'The room changed while you were reviewing. Review the new change list before publishing.',
  'publish.freshSignIn': 'Publishing needs a recent sign-in. Sign in again, then publish.',
  'publish.needsEvidence':
    'A document in this room has no processed version yet. Publishing is blocked until processing finishes.',

  'trash.empty': 'Trash is empty.',
  'trash.retention': 'Items are kept for exactly {days} days, then permanently removed.',
  'trash.nameNotReserved':
    'A trashed name is free to reuse immediately. Restoring needs a name that is not already taken.',
  'trash.restoreNote':
    'Restoring returns an item to draft. It does not restore publication or viewer access.',
  'trash.purgeAfter': 'Removed permanently after',
  'trash.trashedAt': 'Moved to trash',
  'trash.wasPublished': 'Was published before removal',
  'trash.restore': 'Restore',
  'trash.restore.name': 'Restore as',
  'trash.restore.destination': 'Restore into',
  'trash.restore.submit': 'Restore item',
  'trash.restore.pending': 'Restoring…',
  'trash.restore.conflict': 'That name is already used in the destination. Choose another.',

  'search.label': 'Search this room',
  'search.placeholder': 'Titles and descriptions',
  'search.submit': 'Search',
  'search.pending': 'Searching…',
  'search.empty': 'Nothing in this room matches that search.',
  'search.results': '{count} result(s).',
  'search.scope': 'Search covers titles and descriptions in this room only.',

  /*
   * Viewer reading room.
   *
   * Two copy rules carry security weight here. The watermark and screenshot
   * sentences state plainly what Duefold does and does not do: pages are
   * attributed, and screenshots CANNOT be prevented. And the
   * download copy says originals are not watermarked BEFORE a download is
   * offered, because a viewer who assumes an original is attributed may
   * treat it more casually than they should.
   */
  'viewer.rooms.title': 'Your rooms',
  'viewer.rooms.loading': 'Loading rooms',
  'viewer.rooms.empty': 'No rooms are shared with you yet.',
  'viewer.rooms.emptyHelp': 'When someone shares a room with this address, it appears here.',
  'viewer.rooms.open': 'Open room',
  'viewer.rooms.count': '{count} rooms shared with you.',
  'viewer.index.heading': 'Documents',
  'viewer.index.empty': 'This room has no documents you can read.',
  'viewer.index.emptyHelp': 'Only published documents shared with you appear here.',
  'viewer.structure.loading': 'Loading documents',
  'viewer.folder': 'Folder',
  'viewer.document': 'Document',
  'viewer.document.open': 'Read',
  'viewer.document.pages': '{count} pages',
  'viewer.document.loading': 'Opening document',
  'viewer.document.unavailable': 'This document is not available to read.',
  'viewer.document.unavailableHelp':
    'It may have been withdrawn, or access may have changed. Ask the person who shared the room.',
  'viewer.document.selectPrompt': 'Choose a document from the collection index.',
  'viewer.document.selectHelp':
    'Folders organize the index. Documents open here without repeating the collection as a second table.',
  'viewer.document.folderPrompt': 'This is a folder. Choose a document inside it to read.',

  'viewer.page.caption': 'Page {page} of {total}',
  'viewer.page.loading': 'Loading page {page}',
  'viewer.page.failed': 'This page could not be shown.',
  'viewer.page.retry': 'Load this page again',
  'viewer.page.previous': 'Previous page',
  'viewer.page.next': 'Next page',
  'viewer.page.jumpLabel': 'Go to page',
  'viewer.page.jumpSubmit': 'Go',
  'viewer.page.announce': 'Page {page} of {total}.',
  'viewer.page.imageFallback': 'Page {page}. No text could be extracted from this page.',
  'viewer.page.textUnavailable':
    'No searchable text could be extracted from this page. The page image is still shown and described.',

  'viewer.watermark.notice':
    'Every page you see is marked with your email address, the date you opened it, and the room name.',
  'viewer.screenshot.honesty':
    'Screenshots, screen recording, and other browser workarounds are outside Duefold’s control. Treat what you read here as confidential.',
  'viewer.print.unavailable':
    'Duefold has no print action, and document pages are left out of anything you print from your browser.',
  'viewer.introduction.failed':
    'The room introduction could not be loaded. The document access shown here is unchanged.',
  'viewer.print.omitted': 'Document pages are not included in printed output.',

  'viewer.find.label': 'Find on this page',
  'viewer.find.placeholder': 'Text on the current page',
  'viewer.find.submit': 'Find on page',
  'viewer.find.clear': 'Clear search',
  'viewer.find.next': 'Next match',
  'viewer.find.previous': 'Previous match',
  'viewer.find.none': 'No matches on this page.',
  'viewer.find.count': '{count} matches on this page.',
  'viewer.find.position': 'Match {index} of {count}.',
  'viewer.find.scope': 'Find searches the page you are reading.',
  'viewer.page.navigation': 'Document pages',

  'viewer.link.leaving': 'You are leaving Duefold',
  'viewer.link.destination': 'This link goes to',
  'viewer.link.continue': 'Continue to this site',
  'viewer.link.cancel': 'Stay in Duefold',
  'viewer.link.inert':
    'This link could not be checked, so it is shown as plain text and cannot be opened.',
  'viewer.link.resolving': 'Checking this link',
  'viewer.link.failed': 'This link could not be checked. It has not been opened.',

  'viewer.download.heading': 'Original file',
  'viewer.download.allowed': 'You can download the original of this document.',
  'viewer.download.notWatermarked':
    'Downloaded originals are not watermarked. Unlike the pages on screen, a downloaded file carries no mark identifying you.',
  'viewer.download.action': 'Download original',
  'viewer.download.pending': 'Downloading\u2026',
  'viewer.download.progress': '{percent}% downloaded',
  'viewer.download.done': 'Download complete.',
  'viewer.download.failed': 'The download did not finish. Nothing was saved.',
  'viewer.download.expired': 'The download permission expired. Start the download again.',
  'viewer.download.denied': 'Downloading is turned off for this document.',
  'viewer.download.deniedHelp':
    'You can read it here, page by page. Ask the person who shared the room if you need the file itself.',
  'viewer.download.cancel': 'Cancel download',
  'viewer.download.cancelled': 'Download cancelled. Nothing was saved.',

  'viewer.notes.heading': 'What you can do',
  'viewer.revoked': 'Your access to this room has changed. Nothing further is shown.',
  'viewer.expired': 'Your session has ended. Sign in again to keep reading.',

  /*
   * Participants, grants, uploads, and exports. Branding copy lives in the
   * optional module that owns it, so an omitted module takes its strings with it.
   *
   * Copy rules carrying real weight on these surfaces:
   * - An EXPIRED grant is named as expired, never hidden and never shown as
   *   active: a Manager cannot repair access they cannot see.
   * - Grant impact wording never states a number the client computed. The count
   *   and paths are the server's.
   * - A 409 says someone else changed the room and offers a reload. It never
   *   suggests retrying, because retrying would reapply a stale revision.
   * - Irreversible actions say what cannot be undone BEFORE the control.
   */
  /*
   * NOT "this room": the same 409 reaches member administration, where nothing is a room.
   *
   * Mapping SQLSTATE 23505 to 409 gave the member surface this copy, and an Admin inviting
   * an address that was already invited was told someone had changed a room. The phrasing is
   * now true of whatever was being changed, which is all a uniform conflict may claim: the
   * server forwards no wording, so the client cannot name the thing without guessing.
   */
  'error.conflict.title': 'This changed while you were working',
  'error.conflict.body':
    'Someone else changed this while you were working, or it already exists. Reload to see the current state, then make the change again.',
  'error.conflict.reload': 'Reload',
  'error.invalid.body': 'That request was not accepted. Check the values and try again.',
  'error.freshSignIn.title': 'Recent sign-in needed',
  'error.freshSignIn.body':
    'This change affects who can read the room, so it needs a recent sign-in. Sign in again, then repeat the change.',
  'error.freshSignIn.action': 'Sign in again',

  'workspace.tab.structure': 'Collection',
  'workspace.tab.upload': 'Add documents',
  'workspace.tab.participants': 'Access',
  'workspace.tab.processing': 'Processing',
  'workspace.tab.exports': 'Exports',
  'workspace.tab.settings': 'Settings',
  'workspace.tabs.label': 'Room sections',
  'workspace.tab.rooms': 'Rooms',
  'workspace.tab.members': 'Members',
  'workspace.tab.administration': 'Administration',
  'workspace.tab.status': 'Status',
  'administration.sections.label': 'Administration sections',
  'settings.heading': 'Room settings',
  'settings.loading': 'Loading room settings',
  'settings.denied': 'Room settings are not available to your role.',
  'settings.pending': 'Applying…',
  'settings.visibility.heading': 'Visibility',
  'settings.visibility.publish': 'Publish room',
  'settings.visibility.archive': 'Archive room',
  'settings.visibility.returnToDraft': 'Return to draft',
  'settings.visibility.publish.title': 'Publish this room',
  'settings.visibility.archive.title': 'Archive this room',
  'settings.visibility.draft.title': 'Return this room to draft',
  'settings.visibility.publish.consequence':
    'Viewers with a grant will be able to read the published collection. Viewers who gain access: {viewers}. Published documents: {documents}.',
  'settings.visibility.archive.consequence':
    'Viewers lose all content access now. Records and exports remain, and the room can return to draft later. Viewers who lose access: {viewers}.',
  'settings.visibility.draft.consequence':
    'Every viewer loses access to this room immediately. Nothing is deleted, and the room can be published again.',
  'settings.visibility.freshSignIn': 'Publishing needs a sign-in from the last 15 minutes.',
  'settings.visibility.publishStructureFirst':
    'Publish the collection at least once before making the room visible to viewers.',
  'settings.visibility.pinnedByPurge':
    'A purge is scheduled. Cancel it before returning this room to draft.',
  'settings.visibility.done.published': 'Room published.',
  'settings.visibility.done.archived': 'Room archived.',
  'settings.visibility.done.draft': 'Room returned to draft. Viewers no longer have access.',
  'settings.download.heading': 'Original downloads',
  'settings.download.inherit': 'Use the installation default ({policy})',
  'settings.download.allow': 'Allow downloads',
  'settings.download.deny': 'Deny downloads',
  'settings.download.word.allow': 'allowed',
  'settings.download.word.deny': 'denied',
  'settings.download.exceptions': 'Documents with their own download policy: {count}.',
  'settings.download.save': 'Save download policy',
  'settings.download.title': 'Change the download policy',
  'settings.download.consequence.allow':
    'Viewers who can read a document in this room will be able to download its original, unless the document has its own policy.',
  'settings.download.consequence.deny':
    'Viewers will not be able to download originals from this room, unless a document has its own policy.',
  'settings.download.consequence.inherit':
    'This room will follow the installation default, which is currently {policy}.',
  'settings.download.done': 'Download policy saved.',
  'settings.expiry.heading': 'Default grant expiry',
  'settings.expiry.none': 'New grants do not expire unless they set their own date.',
  'settings.expiry.current': 'New grants expire at {local} ({utc}).',
  'settings.expiry.label': 'New grants expire at the end of',
  'settings.expiry.help': 'Leave empty for no default. Existing grants keep their own expiry.',
  'settings.expiry.invalid': 'Choose a real date that is still ahead.',
  'settings.expiry.review': 'Review expiry change',
  'settings.expiry.apply': 'Change default expiry',
  'settings.expiry.title': 'Change the default grant expiry',
  'settings.expiry.consequence':
    'New grants without their own date will expire at {local} ({utc}). Existing grants are unchanged.',
  'settings.expiry.consequenceNone':
    'New grants will not expire unless they set their own date. Existing grants are unchanged.',
  'settings.expiry.done': 'Default grant expiry changed.',
  'settings.lifecycle.freshSignIn': 'This change needs a sign-in from the last 15 minutes.',
  'settings.retention.heading': 'Audit retention',
  'settings.retention.current': 'Audit records for this room are kept for {years} years.',
  'settings.retention.label': 'Keep audit records for',
  'settings.retention.years': '{years} years',
  'settings.retention.review': 'Review retention change',
  'settings.retention.apply': 'Change retention',
  'settings.retention.title': 'Change audit retention',
  'settings.retention.consequence':
    'Audit records written from now on are kept for {years} years. Records already written keep their current retention.',
  'settings.retention.locked': 'Retention is fixed while the room is published or archived.',
  'settings.retention.ownerOnly': 'Only the Owner changes audit retention.',
  'settings.retention.done': 'Audit retention changed.',
  'settings.purge.heading': 'Purge',
  'settings.purge.none': 'No purge is scheduled.',
  'settings.purge.schedule': 'Schedule purge',
  'settings.purge.title': 'Schedule a purge of this room',
  'settings.purge.consequence':
    'After a 30-day cancellation period, every document, version, preview, reader membership and grant in this room is permanently deleted. Pseudonymized audit records remain for the retention period. Provider backups follow their own retention.',
  'settings.purge.counts':
    'Documents: {documents}. Readers: {viewers}. Stored originals: {size}.',
  'settings.purge.scheduled': 'Purge scheduled. It can be cancelled for 30 days.',
  'settings.purge.status.scheduled':
    'Purge scheduled. Everything in this room will be deleted after {local} ({utc}).',
  'settings.purge.status.running': 'Purge in progress.',
  'settings.purge.status.purged': 'This room has been purged.',
  'settings.purge.status.failed':
    'The purge did not complete. Contact the installation operator before changing this room.',
  'settings.purge.cancel': 'Cancel purge',
  'settings.purge.cancelTitle': 'Cancel the scheduled purge',
  'settings.purge.cancelConsequence':
    'Nothing will be deleted. The room stays archived and a purge can be scheduled again later.',
  'settings.purge.cancelled': 'Purge cancelled.',
  'downloads.label': 'Downloads for {name}',
  'downloads.inherit': 'Room default ({policy})',
  'downloads.allow': 'Allowed for this document',
  'downloads.deny': 'Denied for this document',
  'downloads.marker.allow': 'Downloads allowed here',
  'downloads.marker.deny': 'Downloads denied here',
  'downloads.title': 'Change downloads for {name}',
  'downloads.apply': 'Change downloads',
  'downloads.consequence.allow':
    'Viewers who can read this document will be able to download its original, whatever the room policy says.',
  'downloads.consequence.deny':
    'Viewers will not be able to download this document’s original, whatever the room policy says.',
  'downloads.consequence.inherit':
    'This document will follow the room’s policy, which currently resolves to {policy}.',
  'counterparty.heading': 'Counterparties',
  'counterparty.explain':
    'Group readers by the firm they represent. A grant to a counterparty reaches every reader placed in it.',
  'counterparty.none': 'No counterparties yet.',
  'counterparty.caption': 'Counterparties in this room',
  'counterparty.columns.name': 'Counterparty',
  'counterparty.columns.readers': 'Readers',
  'counterparty.columns.actions': 'Actions',
  'counterparty.placement.caption': 'Which counterparty each reader belongs to',
  'counterparty.placement.reader': 'Reader',
  'counterparty.placement.counterparty': 'Counterparty',
  'counterparty.placement.none': 'None',
  'counterparty.placement.choose': 'Counterparty for {email}',
  'counterparty.name': 'Counterparty name',
  'counterparty.nameTaken': 'A counterparty with this name already exists in this room.',
  'counterparty.create': 'Create counterparty',
  'counterparty.creating': 'Creating…',
  'counterparty.created': 'Counterparty {name} created.',
  'counterparty.place': 'Place',
  'counterparty.place.title': 'Place this reader in a counterparty',
  'counterparty.place.consequence':
    '{email} gains the access that {name}’s grants give, immediately. Their own grants are unchanged.',
  'counterparty.placed': 'Reader placed in {name}.',
  'counterparty.remove': 'Remove from {name}',
  'counterparty.remove.title': 'Remove this reader from their counterparty',
  'counterparty.remove.consequence':
    '{email} loses the access that {name}’s grants gave, immediately. Their own grants are unchanged.',
  'counterparty.removed': 'Reader removed from {name}.',
  'counterparty.grant': 'Grant access to {name}',
  'counterparty.grant.review': 'Review grant',
  'counterparty.grant.title': 'Grant access to {name}',
  'counterparty.grant.apply': 'Grant access',
  'counterparty.grant.reach':
    'Every reader placed in {name} gains this access. Readers placed now: {readers}.',
  'counterparty.grant.freshSignIn':
    'A grant to a counterparty needs a sign-in from the last 15 minutes.',
  'confirm.loading': 'Preparing the review…',
  'confirm.typeToConfirm': 'Type {phrase} to confirm',
  'confirm.mismatch': 'Type the phrase exactly as shown to continue.',
  'workspace.views.label': 'Workbench sections',
  'workspace.supporting.label': 'Supporting tools',

  /*
   * Member administration.
   *
   * Copy rules specific to this surface:
   * - An invitation is never described as access. Someone invited has not signed in
   *   and holds nothing, so their row says so in words.
   * - Every state is named; none is carried by colour.
   * - A change that signs someone out says so BEFORE the control that causes it.
   * - The denied state neither confirms nor denies that members exist.
   * - A completed ownership transfer reads as a transfer and a sign-out, never as
   *   an authentication error.
   */
  'members.title': 'Members',
  'members.lead':
    'Everyone inside your organization who can reach Duefold, and which rooms they are staffed into.',
  'members.loading': 'Loading members',
  'members.empty': 'You are the only member of this installation.',
  'members.emptyHelp': 'Invite a colleague to give them access to rooms.',
  'members.denied': 'Member administration is not available to your role.',
  'members.deniedHelp': 'Ask an administrator if you need to invite or staff a colleague.',
  /* A load that FAILED rather than being refused. Distinct copy, because "not
     available to your role" would name the wrong cause and offer no recovery for a
     dropped connection, an ended session, or a server fault. */
  'members.failed': 'The member list could not be loaded.',
  'members.failed.retry': 'Load members again',
  'members.columns.person': 'Person',
  'members.columns.role': 'Role',
  'members.columns.state': 'State',
  'members.columns.rooms': 'Rooms',
  'members.columns.actions': 'Actions',
  'members.role.owner': 'Owner',
  'members.role.admin': 'Admin',
  'members.role.member': 'Member',
  'members.role.owner.explain':
    'Reaches every room, and is the only role that can transfer ownership.',
  'members.role.admin.explain': 'Manages members and reaches every room.',
  'members.role.member.explain': 'Reaches only the rooms they are staffed into.',
  /* An invitation names the role someone WILL hold. Describing it as one they hold
     would claim access before they have ever signed in. */
  'members.role.intended': 'Will arrive as {role}. Holds nothing until they sign in.',
  'members.state.active': 'Active',
  'members.state.disabled': 'Disabled',
  'members.state.disabledHelp': 'Cannot sign in. Their record and audit trail remain.',
  'members.state.invited': 'Invited, not yet signed in',
  'members.state.invitedHelp':
    'This person holds no access yet. They become a member when they first sign in.',
  'members.rooms.none': 'No rooms',
  'members.rooms.byRole': 'Every room, through their organization role',
  'members.rooms.unknown': 'A room not in your list',
  'members.rooms.manage': 'Staff into rooms',
  'members.page.more': 'Load more members',
  'members.page.loadingMore': 'Loading more members\u2026',
  'members.page.partial':
    'This is part of the list. Load the rest before concluding who has access.',

  'members.invite': 'Invite a member',
  'members.invite.note':
    'An invitation lets someone sign in with your identity provider. They arrive in the role you choose here.',
  'members.invite.email': 'Email address',
  'members.invite.emailHelp': 'They sign in with exactly this address.',
  'members.invite.invalid': 'Enter an email address, for example name@example.com.',
  'members.invite.role': 'Role on arrival',
  'members.invite.submit': 'Invite member',
  'members.invite.pending': 'Inviting\u2026',
  'members.invite.sent': 'Invitation sent. It expires in seven days.',
  'members.invite.revoke': 'Withdraw invitation',
  'members.invite.revoked': 'Invitation withdrawn.',

  'members.role.toAdmin': 'Make Admin',
  'members.role.toMember': 'Make Member',
  'members.role.changed': 'Role changed. That member has been signed out of every device.',
  'members.role.signOutWarning':
    'Changing a role signs that member out of every device. They must sign in again.',
  'members.role.supersedesWarning':
    'An Admin reaches every room, so their room assignments are removed by this change.',
  'members.state.disable': 'Disable',
  'members.state.enable': 'Re-enable',
  'members.state.changed': 'Access changed. That member has been signed out of every device.',
  'members.state.disableWarning':
    'A disabled member cannot sign in and is signed out of every device immediately.',

  'members.assign.title': 'Rooms for {person}',
  'members.assign.explain':
    'Choose the rooms this member works in, and whether they manage or contribute.',
  'members.assign.signOutWarning':
    'This member will be signed out of every device and must sign in again.',
  'members.assign.roomRole': 'Role in {room}',
  'members.assign.none': 'Not staffed',
  'members.assign.manager': 'Room manager',
  'members.assign.contributor': 'Contributor',
  'members.assign.submit': 'Save rooms',
  'members.assign.pending': 'Saving rooms\u2026',
  'members.assign.saved': 'Rooms updated. That member has been signed out of every device.',
  'members.assign.unchanged': 'Nothing changed. Choose a different room or role first.',
  /* The server bounds assignments and removals TOGETHER, so a draft can be inside every
     per-list limit and still too large. Said here, with the count, rather than arriving
     as a rejected save. */
  'members.assign.tooLarge':
    'This is {count} changes and one save may carry {limit}. Save some now and the rest afterwards.',
  'members.assign.noRooms': 'There are no rooms to staff anyone into yet.',
  /* The register is paged. If it stopped short, "Not staffed" is an answer about the
     rooms shown and nothing more — the dialog must not imply it saw them all. */
  'members.assign.partialRooms':
    'Only part of the room list loaded. Rooms not shown here are unchanged by this form.',
  'members.assign.onlyMembers':
    'Owners and Admins already reach every room, so they are not staffed into rooms individually.',

  'members.transfer': 'Transfer ownership',
  'members.transfer.title': 'Transfer ownership',
  'members.transfer.loading': 'Working out what this transfer changes',
  'members.transfer.target': 'Ownership moves to {person}.',
  'members.transfer.consequence':
    'You become an Admin and are signed out of every device immediately.',
  'members.transfer.revokes': '{count} room assignment(s) are removed from that person.',
  'members.transfer.revokesNone': 'That person holds no room assignments to remove.',
  'members.transfer.revokesWhy':
    'An Owner reaches every room, so their individual room assignments are removed.',
  'members.transfer.revokesTruncated':
    'The rooms below are part of that list. The count above is exact.',
  'members.transfer.columns.room': 'Room',
  'members.transfer.columns.role': 'Role removed',
  'members.transfer.confirmLabel': 'Type {phrase} to confirm',
  'members.transfer.mismatch': 'Type the phrase exactly as shown to continue.',
  'members.transfer.submit': 'Transfer',
  'members.transfer.pending': 'Transferring\u2026',
  'members.transfer.stale':
    'That person changed while you were reviewing. Review the new impact before transferring.',
  'members.transfer.sessionEnded':
    'Ownership transferred. You are now an Admin and have been signed out of every device.',
  'members.transfer.signInAgain': 'Sign in again',

  'participants.heading': 'Who can read this room',
  'participants.loading': 'Loading participants',
  'participants.empty': 'Nobody outside your organization can read this room yet.',
  'participants.emptyHelp':
    'Invite a reader by email address, then grant them a folder or document.',
  'participants.columns.reader': 'Reader',
  'participants.columns.membership': 'Membership',
  'participants.columns.grants': 'Can read',
  'participants.columns.actions': 'Actions',
  'participants.membership.active': 'Active',
  'participants.membership.revoked': 'Revoked',
  'participants.membership.revokedHelp': 'This reader can no longer open the room.',
  'participants.counterparty': 'Part of {name}',
  'participants.noGrants': 'Nothing yet',
  'participants.noGrantsHelp': 'This reader can open the room but has no content access.',
  'participants.grant.room': 'The whole room',
  'participants.grant.folder': 'A folder',
  'participants.grant.document': 'A document',
  'participants.grant.viaCounterparty': 'Through {name}',
  'participants.grant.direct': 'Granted directly',
  'participants.grant.expires': 'Until {date}',
  'participants.grant.noExpiry': 'No end date',
  'participants.grant.expired': 'Expired on {date}',
  'participants.grant.expiredHelp':
    'This grant has ended, so it gives no access. Change the end date or remove it.',
  'participants.grant.inheritedHelp':
    'Comes from a counterparty grant. Change it on the counterparty grant it derives from.',
  'participants.invite': 'Invite a reader',
  'participants.invite.email': 'Email address',
  'participants.invite.emailHelp':
    'The reader signs in with a code sent to exactly this address.',
  'participants.invite.submit': 'Send invitation',
  'participants.invite.pending': 'Inviting\u2026',
  'participants.invite.done': 'Invitation sent to {email}.',
  'participants.invite.invalid': 'Enter an email address, for example name@example.com.',
  'participants.invite.note':
    'An invitation lets someone open the room. It grants no documents on its own.',

  'grant.action.grant': 'Give access',
  'grant.action.revoke': 'Remove access',
  'grant.action.expiry': 'Change end date',
  'grant.target.label': 'What they can read',
  'grant.target.room': 'The whole room',
  'grant.target.folder': 'One folder',
  'grant.target.document': 'One document',
  'grant.target.pick': 'Choose a folder or document',
  'grant.expiry.label': 'Access ends on',
  'grant.expiry.help': 'Leave empty for access with no end date.',
  'grant.expiry.past': 'Choose a date in the future.',
  'grant.review': 'Review this change',
  'grant.review.pending': 'Checking\u2026',
  'grant.impact.title': 'What this changes',
  'grant.impact.loading': 'Working out what this affects',
  'grant.impact.count': '{count} item(s) change for this reader.',
  'grant.impact.none': 'This changes nothing for this reader.',
  'grant.impact.paths': 'Affected',
  'grant.impact.explain':
    'This is what the server will change. Nothing changes until you confirm.',
  'grant.impact.expiry': 'Access will end on {date}.',
  'grant.impact.noExpiry': 'Access will have no end date.',
  'grant.confirm.label': 'Type {phrase} to confirm',
  'grant.confirm.mismatch': 'Type the phrase exactly as shown to continue.',
  'grant.confirm.submit': 'Apply this change',
  'grant.confirm.pending': 'Applying\u2026',
  'grant.done': 'Access updated.',
  'grant.revoke.warning':
    'Removing access takes effect immediately. Pages already open stop loading.',

  'upload.heading': 'Add documents',
  'upload.pick': 'Choose files',
  'upload.pickDirectory': 'Choose a directory',
  'upload.or': 'or',
  'upload.review': 'Review upload queue',
  'upload.summary': '{count} files · {size} MB',
  'upload.clear': 'Clear queue',
  'upload.title.label': 'Document title',
  'upload.title.help': 'Readers see this title, not the file name.',
  'upload.submit': 'Upload',
  'upload.pending': 'Uploading\u2026',
  'upload.progress': '{percent}% uploaded',
  'upload.done': 'Uploaded. Duefold is now checking the file.',
  'upload.doneCount': '{count} files accepted for checking.',
  'upload.batchDone': '{count} of {total} files accepted for checking.',
  'upload.state.waiting': 'Waiting',
  'upload.state.done': 'Accepted',
  'upload.state.cancelled': 'Cancelled',
  'upload.failed': 'The upload did not finish. Nothing was added.',
  'upload.cancel': 'Cancel upload',
  'upload.cancelled': 'Upload cancelled. Nothing was added.',
  'upload.tooLarge': 'That file is larger than this installation accepts.',
  'upload.note':
    'Choose files or one directory, then review every title. Each file is scanned and converted before anyone can read it.',
  'upload.noFile': 'Choose one or more files to upload.',
  'upload.preflight.count': 'This queue has too many files. Choose 2,000 files or fewer.',
  'upload.preflight.total': 'This queue is larger than the 20 GB directory limit.',
  'upload.preflight.collision':
    'Two paths resolve to the same name. Rename one file and choose the directory again.',
  'upload.preflight.type': 'This directory contains an unsupported file type.',
  'upload.preflight.path':
    'One or more paths are unsafe or unsupported. Check the directory names and try again.',

  'processing.heading': 'Files being checked',
  'processing.loading': 'Loading processing state',
  'processing.empty': 'Nothing is being processed.',
  'processing.emptyHelp': 'Uploaded files appear here while Duefold checks them.',
  'processing.columns.document': 'Document',
  'processing.columns.state': 'State',
  'processing.columns.actions': 'Actions',
  'processing.state.quarantine': 'Being checked',
  'processing.state.quarantineHelp':
    'Held apart from the room until the scan and conversion finish.',
  'processing.state.source_validated': 'Scan passed, converting',
  'processing.state.ready_for_review': 'Ready to publish',
  'processing.state.rejected': 'Not accepted',
  'processing.state.rejectedHelp':
    'Duefold could not accept this file. Delete it and upload a supported document.',
  'processing.state.malware_quarantined': 'Malware found',
  'processing.state.malwareHelp':
    'The scanner found malware. The file is isolated and cannot be published or downloaded.',
  'processing.state.processing_failed': 'Conversion failed',
  'processing.state.processingFailedHelp':
    'Conversion did not finish. You can try once more, or delete the file.',
  'processing.state.failed_source_deletion_pending': 'Deleting',
  'processing.state.malware_source_deletion_pending': 'Deleting',
  'processing.state.failed_source_deleted': 'Deleted',
  'processing.state.malware_source_deleted': 'Deleted',
  'processing.state.unknown': 'In progress',
  'processing.retry': 'Try conversion again',
  'processing.retry.pending': 'Retrying\u2026',
  'processing.retry.once': 'A failed conversion can be retried once.',
  'processing.retry.exhausted': 'This file has already been retried. Delete it to clear it.',
  'processing.retained': 'Kept until {date}',
  'processing.delete': 'Delete this file',
  'processing.delete.pending': 'Deleting\u2026',
  'processing.delete.warning':
    'Deleting the stored file cannot be undone. The record of the attempt stays in the audit trail.',
  'processing.delete.confirmLabel': 'Type {phrase} to delete',
  'processing.delete.confirm': 'Delete permanently',
  'processing.refresh': 'Check again',

  'exports.heading': 'Exports',
  'exports.loading': 'Loading exports',
  'exports.empty': 'No exports yet.',
  'exports.emptyHelp':
    'An export gathers this room’s records into a single file you download once.',
  'exports.columns.preset': 'Contents',
  'exports.columns.state': 'State',
  'exports.columns.expires': 'Available until',
  'exports.columns.actions': 'Actions',
  'exports.preset.room-index-audit': 'Room index and audit trail',
  'exports.preset.participant-access': 'Readers and their access',
  'exports.preset.selected-documents': 'Chosen documents',
  'exports.includeOriginals': 'Includes original files',
  'exports.state.generating': 'Being prepared',
  'exports.state.ready': 'Ready to download once',
  'exports.state.consumed': 'Already downloaded',
  'exports.state.consumedHelp':
    'An export can be downloaded once. Generate a new one if you need it again.',
  'exports.state.expired': 'Expired',
  'exports.state.deletion_pending': 'Being deleted',
  'exports.state.deleted': 'Deleted',
  'exports.state.failed': 'Preparation failed',
  'exports.state.unknown': 'In progress',
  'exports.create': 'Create an export',
  'exports.preset.label': 'What to include',
  'exports.originals.label': 'Include the original files',
  'exports.originals.help':
    'Original files are not watermarked. A downloaded original carries no mark identifying who received it.',
  'exports.preflight': 'Review this export',
  'exports.preflight.loading': 'Working out what this export contains',
  'exports.preflight.title': 'What this export contains',
  'exports.preflight.files': '{count} file(s).',
  'exports.preflight.size': 'About {size}.',
  'exports.preflight.pii': 'Personal data included',
  'exports.preflight.retention': 'Retention',
  'exports.preflight.confirm': 'Create this export',
  'exports.preflight.pending': 'Preparing\u2026',
  'exports.oneTime':
    'This file can be downloaded ONCE. After that it is deleted and you need a new export.',
  'exports.download': 'Download once',
  'exports.download.pending': 'Downloading\u2026',
  'exports.download.done': 'Downloaded. This export is now used up.',
  'exports.download.failed': 'The download did not finish. This export may already be used up.',
  'exports.expiry': 'An export expires one hour after it is created.',
  'exports.freshSignIn':
    'Creating an export needs a recent sign-in. Sign in again, then retry.',

  'bulk.label': 'Select items',
  'bulk.selectAll': 'Select all',
  'bulk.clear': 'Clear selection',
  'bulk.selected': '{count} of {total} selected.',
  'bulk.none': 'Nothing selected.',
  'bulk.selectRow': 'Select {name}',
  'bulk.action.stageRemoval': 'Stage removal of selected',
  'bulk.action.move': 'Move selected',
  'bulk.confirm.stageRemoval': 'Stage removal of {count} selected items?',
  'bulk.pending': 'Applying to {count} selected items…',
  'bulk.partial': '{done} of {total} items changed before an error stopped the rest.',

  'structure.createFolder.parent': 'Inside',
  'structure.createFolder.pending': 'Creating\u2026',
  'structure.move.pending': 'Moving\u2026',
  'structure.metadata': 'Edit title and description',
  /*
   * Distinct from `upload.title.label` ("Document title") on purpose: both fields
   * can be on screen at once, and two controls whose accessible names differ only
   * by a prefix are ambiguous to a screen-reader user reading a list of form
   * fields, as well as to anyone scanning the page.
   */
  'structure.metadata.title': 'Title of this document',
  'structure.metadata.description': 'Description of this document',
  'structure.metadata.submit': 'Save details',
  'structure.metadata.pending': 'Saving\u2026',

  'status.heading': 'Security and deployment status',
  'status.intro':
    'Read-only. Status reports what this installation can observe; it does not configure infrastructure, components, providers or secrets.',
  'status.loading': 'Loading status',
  'status.denied': 'Status is not available to your role.',
  'status.refresh': 'Check again',
  'status.caption': 'Security and deployment checks',
  'status.column.check': 'Check',
  'status.column.state': 'State',
  'status.column.details': 'Details',
  'status.column.time': 'As of',
  'status.now': 'Now',
  'status.never': 'Never recorded',
  'status.summary.failing': 'Checks failing: {count}.',
  'status.state.pass': 'Passing',
  'status.state.attention': 'Needs attention',
  'status.state.fail': 'Failing',
  'status.state.unchecked': 'Not yet checked',
  'status.state.stale': 'Out of date',
  'status.row.application': 'Application',
  'status.row.migrations': 'Database migrations',
  'status.row.storagePrivacy': 'Storage privacy',
  'status.row.storageVersioning': 'Storage versioning',
  'status.row.scanner': 'Malware signatures',
  'status.row.queue': 'Worker queue',
  'status.row.processing': 'Document processing',
  'status.row.oidc': 'Member sign-in (OIDC)',
  'status.row.mail': 'Required mail',
  'status.row.backups': 'Backups',
  'status.row.restore': 'Restore drill',
  'status.row.updates': 'Updates and advisories',
  'status.application.version': 'Version {version}',
  'status.application.modules': 'Installed: {installed}',
  'status.application.adapters': 'Storage {storage}, mail {mail}, identity {identity}',
  'status.migrations.current': 'All {expected} migrations applied.',
  'status.migrations.pending': '{applied} of {expected} migrations applied. Run db migrate.',
  'status.migrations.unrecognized':
    'The database records {applied} migrations this release did not produce; it expects {expected}.',
  'status.migrations.latest': 'Latest: {id}',
  'status.unchecked.worker': 'The worker checks this every hour.',
  'status.unchecked.updates': 'Run updates check-file with the latest release package.',
  'status.code.ANONYMOUS_ACCESS_REFUSED':
    'The storage API refuses unauthenticated requests. A public address the provider serves outside that API is not visible to this check.',
  'status.code.ANONYMOUS_READ_ALLOWED':
    'The storage API answers unauthenticated requests about objects. Turn public access off.',
  'status.code.ANONYMOUS_LIST_ALLOWED':
    'The storage API lists contents to unauthenticated requests. Turn public access off.',
  'status.code.STORAGE_PROBE_INCONCLUSIVE':
    'The storage API gave an answer this check cannot read.',
  'status.code.STORAGE_UNREACHABLE': 'The worker could not reach object storage.',
  'status.code.VERSIONING_ENABLED': 'Object versioning is enabled.',
  'status.code.VERSIONING_SUSPENDED':
    'Object versioning is suspended, so deleted or overwritten objects cannot be restored.',
  'status.code.VERSIONING_NEVER_ENABLED': 'Object versioning has never been enabled.',
  'status.code.VERSIONING_NOT_DETECTABLE':
    'Versioning cannot be read with the worker credential or this provider. Confirm it with your provider.',
  'status.code.SIGNATURES_CURRENT': 'Signatures are less than a day old.',
  'status.code.SIGNATURES_STALE':
    'Signatures are more than a day old. New uploads cannot be scanned until they update.',
  'status.code.SCANNER_UNAVAILABLE':
    'The worker could not reach the scanner. New uploads cannot be scanned until it answers.',
  'status.code.UPDATE_CURRENT': 'No newer release is known.',
  'status.code.UPDATE_AVAILABLE': 'A newer release is available.',
  'status.code.SECURITY_ADVISORY': 'A newer release fixes a security advisory. Upgrade.',
  'status.code.UPDATE_MANIFEST_UNVERIFIED':
    'The last release package checked did not verify. Do not use it.',
  'status.code.UPDATE_VERSION_UNRECOGNIZED':
    'The last release package named a version this release cannot compare.',
  'status.scanner.builtAt': 'Built {date}, {days} days before this check.',
  'status.updates.offered': 'Offered release: {version}',
  'status.queue.counts': '{due} jobs waiting, {running} running.',
  'status.queue.failed': '{count} jobs failed after every retry in the last seven days.',
  'status.queue.backlog': 'The oldest waiting job has waited {minutes} minutes.',
  'status.processing.none': 'No document versions have failed processing.',
  'status.processing.failed':
    '{count} document versions failed processing. Members can retry them from Processing.',
  'status.oidc.conformed':
    'Discovery and client authentication conformed when this web process started.',
  'status.mail.delivering': 'Sign-in and invitation mail is being delivered.',
  'status.mail.failing':
    '{count} sign-in or invitation messages could not be delivered after every retry in the last seven days.',
  'status.mail.untested': 'No sign-in or invitation mail has been sent yet.',
  'status.backups.acknowledged': 'Backups are acknowledged by the operator.',
  'status.backups.retention': 'Retention: {retention}',
  'status.backups.expectation': 'Recovery expectation: {expectation}',
  'status.backups.undetermined':
    'Backup status has not been recorded. Run backup-status acknowledge after checking with your provider.',
  'status.restore.untested': 'No restore drill has been recorded.',
  'status.restore.passed': 'The last restore drill passed.',
  'status.restore.failed': 'The last restore drill did not pass.',
  'workspace.tab.installation': 'Installation',
  'installation.heading': 'Installation settings',
  'installation.loading': 'Loading installation settings',
  'installation.denied': 'Installation settings are not available to your role.',
  'installation.download.heading': 'Original downloads',
  'installation.download.allowed': 'Allowed by default',
  'installation.download.denied': 'Denied by default',
  'installation.download.explain':
    'Every room and document without its own policy inherits this. {rooms} rooms inherit it now.',
  'installation.download.allow': 'Allow original downloads',
  'installation.download.deny': 'Deny original downloads',
  'installation.download.allow.title': 'Allow original downloads installation-wide',
  'installation.download.deny.title': 'Deny original downloads installation-wide',
  'installation.download.allow.consequence':
    'Viewers will be able to download originals in the {rooms} rooms that inherit this default, including {documents} published documents they can open now.',
  'installation.download.deny.consequence':
    'Original downloads stop in the {rooms} rooms that inherit this default, including {documents} published documents viewers can open now. Rooms and documents with their own policy keep it.',
  'installation.download.freshSignIn':
    'This change needs a sign-in within the last 15 minutes.',
  'installation.download.done.allow': 'Original downloads are now allowed by default.',
  'installation.download.done.deny': 'Original downloads are now denied by default.',
} as const;

export type MessageKey = keyof typeof messages;
