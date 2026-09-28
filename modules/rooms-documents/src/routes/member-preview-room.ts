import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { roomSchema as schema, createRoomHandler } from './member-preview.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return createRoomHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('member preview room route runtime not initialized');
}
