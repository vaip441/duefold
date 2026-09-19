import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { deliverySchema as schema, createDeliveryHandler } from './protected-page.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createDeliveryHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('protected page delivery route runtime not initialized');
}
