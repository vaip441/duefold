/**
 * The scheduled sweep that removes spent ownership-transfer previews.
 *
 * A preview is one-time evidence that the required dry run happened. `transfer_ownership`
 * consumes it, and an unused one lapses, so both are dead rows the moment they are marked
 * — but nothing deleted them. `ownership_transfer_preview` is deliberately free of
 * personal data (the rendered impact is returned to the caller, never stored), so this is
 * not a privacy fix; it is §23's rule that no table grows without bound.
 *
 * `DELETE` is idempotent, so a retried job, or one overlapping the next run the runner
 * queued, is harmless.
 */

import type { Pool } from 'pg';

export interface OwnershipPreviewPurgeDependencies {
  readonly pool: Pool;
}

export function createHandler(dependencies: OwnershipPreviewPurgeDependencies) {
  return async (): Promise<void> => {
    await dependencies.pool.query('SELECT purge_ownership_transfer_previews()');
  };
}
