import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, {
  type FastifyRequest,
  type FastifySchema,
  LogController,
  type onRequestHookHandler,
  type RouteHandlerMethod,
} from 'fastify';
import pino from 'pino';
import {
  generatedRoutes,
  type GeneratedRouteAudience,
  type GeneratedRouteEntry,
  type GeneratedRouteId,
} from '../../../.duefold/generated/routes.ts';
import { createCorrelationId } from '@duefold/shared/ids';
import { allowlistedTelemetry, type TelemetryRecord } from '@duefold/shared/redact';
import { constantTimeDigestMatch } from '../../../modules/core-security/src/sessions.ts';
import { classifyFailure } from './failure-mapping.ts';
import type { AuthenticatedSession } from './authenticate.ts';
import { routeAuthorized, type RouteAuthority } from './route-authority.ts';
import { resolveStaticAsset, type StaticClient } from './static-client.ts';
import type { WebRuntime } from './runtime.ts';
import type { TrustProxyOption } from './proxy.ts';
import type { ReadinessDependencies } from '../../../modules/core-security/src/routes/health-ready.ts';

const CSRF_HEADER = 'x-duefold-csrf';
const MAX_BODY_BYTES = 1_048_576;
export interface WebDependencies {
  readonly runtime: WebRuntime;
  readonly authenticate: (request: FastifyRequest) => Promise<AuthenticatedSession | null>;
  readonly logDestination?: pino.DestinationStream;
  /** Built browser client. Omitted only by API-level tests. */
  readonly staticClient?: StaticClient;
  /**
   * TLS material. Session and CSRF cookies are `Secure`, so a browser drops
   * them over plain HTTP; a browser-level test therefore needs real TLS.
   * Production terminates TLS at the deployment boundary.
   */
  readonly https?: { readonly key: string; readonly cert: string };
  /*
   * Test harnesses only. A browser leaves keep-alive sockets open after the last
   * assertion, and close() waits for every connection to drain, so teardown can
   * outlast the suite's hook budget. Production keeps the draining default so an
   * in-flight request is never cut off mid-response.
   */
  readonly forceCloseConnections?: boolean;
  /**
   * Fastify trustProxy configuration. When omitted or false, X-Forwarded-For is
   * ignored and request.ip is the direct socket address.
   */
  readonly trustProxy?: TrustProxyOption;
  /** Production readiness probes. Every composition supplies the complete,
   * fail-closed dependency set; tests must do the same explicitly. */
  readonly readiness: ReadinessDependencies;
}
function isRouteSchema(schema: unknown): schema is FastifySchema {
  return typeof schema === 'object' && schema !== null && 'response' in schema;
}
function csrfValid(request: FastifyRequest, session: AuthenticatedSession): boolean {
  const value = request.headers[CSRF_HEADER];
  return typeof value === 'string' && constantTimeDigestMatch(value, session.csrfDigest);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function property(value: unknown, key: string, fallback: string | number): unknown {
  if (!isRecord(value)) return fallback;
  return value[key] ?? fallback;
}
function safeLogInput(value: unknown): TelemetryRecord {
  const allowed = allowlistedTelemetry(value);
  if (isRecord(value) && 'err' in value)
    /*
     * An `err` is replaced with a fixed marker so a thrown message, stack, or
     * attached provider text can never be serialized. A caller that supplied its
     * own allowlisted event and code keeps them: that is how a sign-in refusal
     * records WHY it was refused while still never writing free text. The
     * allowlist has already dropped anything outside the closed value sets, so
     * this cannot widen what is loggable.
     */
    return {
      ...allowed,
      event: allowed['event'] ?? 'request.failed',
      code: allowed['code'] ?? 'REQUEST_FAILED',
    } satisfies TelemetryRecord;
  return allowed;
}
const AUTHORITIES = {
  public: { kind: 'public' },
  member: { kind: 'member' },
  viewer: { kind: 'viewer' },
} as const satisfies Record<GeneratedRouteAudience, RouteAuthority>;

interface RuntimeHandlerInput {
  readonly runtime: WebRuntime;
  readonly session: AuthenticatedSession | null;
  readonly authenticate: (request: FastifyRequest) => Promise<AuthenticatedSession | null>;
}
type RuntimeRouteFactory = (input: RuntimeHandlerInput) => RouteHandlerMethod;
const PUBLIC_RUNTIME_HANDLER: RuntimeRouteFactory = () => {
  throw new Error('public route handler must be selected by route id');
};
const ROUTE_FACTORIES = {
  'health.live': PUBLIC_RUNTIME_HANDLER,
  'health.ready': () => {
    throw new Error('readiness dependencies missing');
  },
  'auth.session': ({ runtime, authenticate }) =>
    routeById('auth.session').handlerFactory(runtime, authenticate),
  'auth.oidc.begin': ({ runtime }) => routeById('auth.oidc.begin').handlerFactory(runtime),
  'auth.oidc.callback': ({ runtime }) =>
    routeById('auth.oidc.callback').handlerFactory(runtime),
  'auth.otp.request': ({ runtime }) => routeById('auth.otp.request').handlerFactory(runtime),
  'auth.otp.verify': ({ runtime }) => routeById('auth.otp.verify').handlerFactory(runtime),
  'auth.sign-out.member': authenticatedFactory('auth.sign-out.member', false),
  'auth.sign-out.viewer': authenticatedFactory('auth.sign-out.viewer', false),
  'auth.sign-out-all.member': authenticatedFactory('auth.sign-out-all.member', true),
  'auth.sign-out-all.viewer': authenticatedFactory('auth.sign-out-all.viewer', true),
  'export.list': memberFactory('export.list'),
  'export.manage': memberFactory('export.manage'),
  'export.download': memberFactory('export.download'),
  'upload.intent.create': memberFactory('upload.intent.create'),
  'room.list': memberFactory('room.list'),
  'room.create': memberFactory('room.create'),
  'room.workspace.read': memberFactory('room.workspace.read'),
  'room.structure.mutate': memberFactory('room.structure.mutate'),
  'room.action': memberFactory('room.action'),
  'room.lifecycle': memberFactory('room.lifecycle'),
  'upload.intent.finalize': memberFactory('upload.intent.finalize'),
  'document.processing.state': memberFactory('document.processing.state'),
  'document.processing.retry': memberFactory('document.processing.retry'),
  'document.failed-source.delete': memberFactory('document.failed-source.delete'),
  'viewer.room.list': viewerFactory('viewer.room.list'),
  'viewer.structure.read': viewerFactory('viewer.structure.read'),
  'viewer.structure.search': viewerFactory('viewer.structure.search'),
  'viewer.document.read': viewerFactory('viewer.document.read'),
  'protected.link.interstitial': viewerFactory('protected.link.interstitial'),
  'protected.page.create': viewerFactory('protected.page.create'),
  'protected.page.deliver': viewerFactory('protected.page.deliver'),
  'protected.page.text': viewerFactory('protected.page.text'),
  'preview.begin': viewerFactory('preview.begin'),
  'preview.heartbeat': viewerFactory('preview.heartbeat'),
  'preview.close': viewerFactory('preview.close'),
  'download.lease.create': viewerFactory('download.lease.create'),
  'download.range': viewerFactory('download.range'),
  'participant.list': memberFactory('participant.list'),
  'participant.invite': memberFactory('participant.invite'),
  'grant.change': memberFactory('grant.change'),
  'room.settings.read': memberFactory('room.settings.read'),
  'room.visibility': memberFactory('room.visibility'),
  'policy.change': memberFactory('policy.change'),
  'counterparty.change': memberFactory('counterparty.change'),
  'organization.members.list': memberFactory('organization.members.list'),
  'organization.members.actions': memberFactory('organization.members.actions'),
  'branding.asset.upload': memberFactory('branding.asset.upload'),
  'branding.configuration': memberFactory('branding.configuration'),
  'branding.asset.delete': memberFactory('branding.asset.delete'),
  'branding.support-contact': ({ runtime }) =>
    routeById('branding.support-contact').handlerFactory(runtime),
  'branding.public': ({ runtime }) => routeById('branding.public').handlerFactory(runtime),
  'branding.viewer-introduction': viewerFactory('branding.viewer-introduction'),
  'branding.asset.get': ({ runtime }) =>
    routeById('branding.asset.get').handlerFactory(runtime),
} satisfies Record<GeneratedRouteId, RuntimeRouteFactory>;

function routeById<Id extends GeneratedRouteId>(
  id: Id,
): Extract<GeneratedRouteEntry, { id: Id }> {
  const route = generatedRoutes.find((entry) => entry.id === id);
  if (route === undefined) throw new Error('generated route missing');
  return route as Extract<GeneratedRouteEntry, { id: Id }>;
}
function memberFactory(
  id:
    | 'upload.intent.create'
    | 'upload.intent.finalize'
    | 'document.processing.state'
    | 'document.processing.retry'
    | 'document.failed-source.delete'
    | 'room.list'
    | 'room.create'
    | 'room.workspace.read'
    | 'room.structure.mutate'
    | 'room.action'
    | 'room.lifecycle'
    | 'export.list'
    | 'export.manage'
    | 'export.download'
    | 'participant.list'
    | 'participant.invite'
    | 'grant.change'
    | 'room.settings.read'
    | 'room.visibility'
    | 'policy.change'
    | 'counterparty.change'
    | 'organization.members.list'
    | 'organization.members.actions'
    | 'branding.asset.upload'
    | 'branding.configuration'
    | 'branding.asset.delete',
): RuntimeRouteFactory {
  return ({ runtime, session }) => {
    if (session?.principal.kind !== 'member') throw new Error('member session missing');
    return routeById(id).handlerFactory(runtime, session.principal);
  };
}
function viewerFactory(
  id:
    | 'viewer.room.list'
    | 'viewer.structure.read'
    | 'viewer.structure.search'
    | 'viewer.document.read'
    | 'branding.viewer-introduction'
    | 'protected.link.interstitial'
    | 'protected.page.create'
    | 'protected.page.deliver'
    | 'protected.page.text'
    | 'preview.begin'
    | 'preview.heartbeat'
    | 'preview.close'
    | 'download.lease.create'
    | 'download.range',
): RuntimeRouteFactory {
  return ({ runtime, session }) => {
    if (session?.principal.kind !== 'viewer') throw new Error('viewer session missing');
    return routeById(id).handlerFactory(runtime, session.principal);
  };
}
function authenticatedFactory(
  id:
    | 'auth.sign-out.member'
    | 'auth.sign-out.viewer'
    | 'auth.sign-out-all.member'
    | 'auth.sign-out-all.viewer',
  allDevices: boolean,
): RuntimeRouteFactory {
  return ({ runtime, session }) => {
    if (session === null) throw new Error('authenticated session missing');
    return routeById(id).handlerFactory(runtime, session, allDevices);
  };
}
function runtimeHandler(
  route: GeneratedRouteEntry,
  dependencies: WebDependencies,
  session: AuthenticatedSession | null,
): RouteHandlerMethod {
  if (route.id === 'health.live') {
    if (typeof route.handler !== 'function')
      throw new Error(`invalid route handler: ${route.id}`);
    return route.handler;
  }
  if (route.id === 'health.ready') return route.handlerFactory(dependencies.readiness);
  return ROUTE_FACTORIES[route.id]({
    runtime: dependencies.runtime,
    session,
    authenticate: (request) => dependencies.authenticate(request),
  });
}

export function createWebLogger(destination?: pino.DestinationStream): pino.Logger {
  const options = {
    level: 'info',
    hooks: {
      logMethod(this: pino.Logger, arguments_: Parameters<pino.LogFn>, method: pino.LogFn) {
        method.apply(this, [safeLogInput(arguments_[0])]);
      },
    },
    serializers: {
      req: (request: unknown): object =>
        allowlistedTelemetry({
          method: property(request, 'method', 'unknown'),
          correlation: property(request, 'id', 'unknown'),
        }),
      res: (response: unknown): object =>
        allowlistedTelemetry({ status: property(response, 'statusCode', 500) }),
      err: (): object => ({ event: 'request.failed', code: 'REQUEST_FAILED' }),
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export async function buildWebApp(dependencies: WebDependencies) {
  if (dependencies.runtime.watermarkProgram === undefined)
    throw new Error('WATERMARK_ADAPTER_UNAVAILABLE');
  const logger = createWebLogger(dependencies.logDestination);
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => createCorrelationId(),
    loggerInstance: logger,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    trustProxy: dependencies.trustProxy ?? false,
    ...(dependencies.https === undefined ? {} : { https: dependencies.https }),
    ...(dependencies.forceCloseConnections === true ? { forceCloseConnections: true } : {}),
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The built client ships one external stylesheet and no inline style
        // element. `'unsafe-inline'` is deliberately absent, and no hash is
        // needed because nothing inlines style.
        styleSrc: ["'self'"],
        // Fonts are self-hosted from this origin; a third-party font request
        // would disclose viewer activity.
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
  });
  /*
   * Authorization denials, validation failures, and optimistic conflicts all
   * arrived as HTTP 500, which made a refused request indistinguishable from a
   * crashed one. Clients could not implement the designed denied state, and a
   * real fault was hidden among expected refusals. The SECURITY DEFINER
   * functions already raise a deliberate taxonomy, so map it.
   *
   * Messages stay uniform and non-enumerating: a denied request must not reveal
   * whether the room, folder, or document exists, so every 403 says the same
   * thing regardless of which predicate refused. The server-side log keeps the
   * detail.
   */
  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error });
    const classified = classifyFailure(error);
    if (classified !== null) {
      void reply.code(classified.status).send({ error: classified.body });
      return;
    }
    void reply.code(500).send({
      error: { code: 'INTERNAL', message: 'The request could not be completed.' },
    });
  });
  app.addHook('onSend', async (_request, reply) => {
    // Protected responses are never cached. A handler that has
    // already stated a policy — only the content-hashed static assets do — keeps
    // it; everything else gets no-store.
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'private, no-store');
  });
  const authenticated = new WeakMap<FastifyRequest, AuthenticatedSession>();
  // Routes that need no session are constructed once, at startup. Configuration
  // a route validates when it is wired therefore fails startup rather than
  // failing per request.
  const eagerHandlers = new Map<GeneratedRouteId, RouteHandlerMethod>();
  for (const route of generatedRoutes) {
    if (route.audience !== 'public') continue;
    eagerHandlers.set(route.id, runtimeHandler(route, dependencies, null));
  }
  for (const route of generatedRoutes) {
    if (!isRouteSchema(route.schema)) throw new Error(`invalid generated schema: ${route.id}`);
    const routeAuthority = AUTHORITIES[route.audience];
    const onRequest: onRequestHookHandler = (request, reply, done): void => {
      if (routeAuthority.kind === 'public') {
        done();
        return;
      }
      void dependencies.authenticate(request).then((session) => {
        if (!routeAuthorized(routeAuthority, session?.principal ?? null)) {
          void reply.code(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
          });
          return;
        }
        if (session === null) {
          done(new Error('authenticated session missing'));
          return;
        }
        if (route.csrf && !csrfValid(request, session)) {
          void reply
            .code(403)
            .send({ error: { code: 'FORBIDDEN', message: 'The request is not permitted.' } });
          return;
        }
        authenticated.set(request, session);
        done();
      }, done);
    };
    app.route({
      method: route.method,
      url: route.path,
      schema: route.schema,
      onRequest,
      handler: (request, reply) => {
        const session = authenticated.get(request) ?? null;
        if (routeAuthority.kind !== 'public' && session === null)
          throw new Error('authenticated session missing');
        const handler =
          eagerHandlers.get(route.id) ?? runtimeHandler(route, dependencies, session);
        return handler.call(request.server, request, reply);
      },
    });
  }
  const staticClient = dependencies.staticClient;
  if (staticClient !== undefined) {
    // Registered after every API route, so it can never shadow one. `/api/*`
    // misses stay JSON 404s; other paths resolve from the exact-match manifest
    // or fall back to the application shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        void reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
        });
        return;
      }
      const asset = resolveStaticAsset(staticClient, request.url.split('?')[0] ?? '/');
      if (asset === undefined) {
        void reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
        });
        return;
      }
      void reply
        .header('Content-Type', asset.contentType)
        .header(
          'Cache-Control',
          asset.immutable ? 'private, max-age=31536000, immutable' : 'private, no-store',
        )
        .send(asset.body);
    });
  }
  return app;
}
