/** The composition this process was built from, as the status surface reports it. */
import { composedManifest } from '../../../.duefold/generated/manifest.ts';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import type { DeploymentFacts } from '../../../modules/core-security/src/deployment-status.ts';
import { applicationVersion } from '../../../modules/core-security/src/release.ts';

export function composedDeploymentFacts(oidcDiscoveryConformedAt: Date): DeploymentFacts {
  return {
    applicationVersion: applicationVersion(),
    modules: [...composedManifest.modules],
    adapters: { ...composedManifest.adapters },
    expectedMigrationIds: generatedMigrations.map(({ id }) => id),
    oidcDiscoveryConformedAt: oidcDiscoveryConformedAt.toISOString(),
  };
}
