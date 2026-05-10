/**
 * OpenAPI Route Registry
 *
 * Provides a thin wrapper around Express Router that captures route metadata
 * (schemas, descriptions, tags) alongside handler registration. The metadata
 * is used to auto-generate an OpenAPI 3.1 specification at startup.
 *
 * This eliminates the need for a manually maintained OpenAPI document —
 * routes and their documentation are defined in one place.
 *
 * Usage:
 *   const api = createApiRouter('Backups');
 *   api.get('/scheduler', {
 *     summary: 'Get scheduler status',
 *     responses: { 200: { description: 'Scheduler status' } },
 *   }, handler);
 *   export const backupRouter = api.router;
 */

import { Router, type RequestHandler } from 'express';
import type { TSchema } from '@sinclair/typebox';
import { createRequire } from 'module';
import { validate } from '../middleware/validate.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch';

interface ResponseDef {
  description: string;
  content?: Record<string, { schema?: TSchema | Record<string, unknown> }>;
}

interface RequestBodyDef {
  description?: string;
  required?: boolean;
  content: Record<string, { schema?: TSchema | Record<string, unknown> }>;
}

/** Route-level OpenAPI metadata */
export interface RouteSpec {
  /** Short summary shown in Swagger UI */
  summary: string;
  /** Longer description (markdown) */
  description?: string;
  /** Override default tag(s) for this route */
  tags?: string[];
  /** TypeBox schema for request body validation */
  body?: TSchema;
  /** TypeBox schema for path params validation */
  params?: TSchema;
  /** TypeBox schema for query string validation */
  query?: TSchema;
  /** Response definitions keyed by status code */
  responses?: Record<number, ResponseDef>;
  /** Custom request body (overrides auto-generated from `body`) */
  requestBody?: RequestBodyDef;
  /** Mark as deprecated */
  deprecated?: boolean;
}

interface RouteEntry {
  method: HttpMethod;
  path: string;
  spec: RouteSpec;
  prefix: string;
  tags: string[];
}

/** All registered routes across all ApiRouter instances */
const registry: RouteEntry[] = [];

/** Collected TypeBox schemas for the components section */
const componentSchemas = new Map<string, TSchema>();

/**
 * Register a TypeBox schema in the OpenAPI components/schemas section.
 * Schemas with a `$id` property are automatically registered.
 */
export function registerSchema(schema: TSchema): void {
  const id = (schema as Record<string, unknown>).$id as string | undefined;
  if (id) {
    componentSchemas.set(id, schema);
  }
}

export interface ApiRouter {
  /** The underlying Express Router (mount this in server.ts) */
  router: Router;
  /** Register a GET route with OpenAPI metadata */
  get(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void;
  /** Register a POST route with OpenAPI metadata */
  post(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void;
  /** Register a PUT route with OpenAPI metadata */
  put(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void;
  /** Register a DELETE route with OpenAPI metadata */
  delete(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void;
  /** Register a PATCH route with OpenAPI metadata */
  patch(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void;
  /** Set the mount prefix (called by setRoutePrefix) */
  setPrefix(prefix: string): void;
  /** Get the default tag */
  defaultTag: string;
}

/**
 * Create an ApiRouter that captures OpenAPI metadata.
 *
 * @param defaultTag - Default OpenAPI tag for all routes on this router
 */
export function createApiRouter(defaultTag: string): ApiRouter {
  const router = Router();
  let prefix = '';

  function register(
    method: HttpMethod,
    path: string,
    spec: RouteSpec,
    handlers: RequestHandler[]
  ): void {
    // Auto-register schemas that have $id
    if (spec.body) registerSchema(spec.body);
    if (spec.params) registerSchema(spec.params);
    if (spec.query) registerSchema(spec.query);

    registry.push({
      method,
      path,
      spec,
      prefix,
      tags: spec.tags ?? [defaultTag],
    });

    const middlewares: RequestHandler[] = [];

    if (spec.body || spec.params || spec.query) {
      middlewares.push(
        validate({
          body: spec.body,
          params: spec.params,
          query: spec.query,
        })
      );
    }

    middlewares.push(...handlers);
    router[method](path, ...middlewares);
  }

  const api: ApiRouter = {
    router,
    defaultTag,
    get: (path, spec, ...handlers) => register('get', path, spec, handlers),
    post: (path, spec, ...handlers) => register('post', path, spec, handlers),
    put: (path, spec, ...handlers) => register('put', path, spec, handlers),
    delete: (path, spec, ...handlers) => register('delete', path, spec, handlers),
    patch: (path, spec, ...handlers) => register('patch', path, spec, handlers),
    setPrefix: (p: string) => {
      prefix = p;
    },
  };

  return api;
}

/**
 * Associates a mount prefix with an ApiRouter.
 * Must be called before generateOpenApiDocument().
 */
export function setRoutePrefix(api: ApiRouter, prefix: string): void {
  api.setPrefix(prefix);

  // Retroactively update already-registered routes for this router
  for (const entry of registry) {
    if (entry.tags.includes(api.defaultTag) && entry.prefix === '') {
      entry.prefix = prefix;
    }
  }
}

/**
 * Set prefix for routes by their default tag name.
 * Convenience alternative to setRoutePrefix when you don't have the ApiRouter object.
 */
export function setRoutePrefixByTag(tag: string, prefix: string): void {
  for (const entry of registry) {
    if (entry.tags.includes(tag) && entry.prefix === '') {
      entry.prefix = prefix;
    }
  }
}

/** Convert Express path params (:id) to OpenAPI format ({id}) */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, '{$1}');
}

/** Build OpenAPI parameters from a TypeBox schema */
function schemaToParameters(
  schema: TSchema,
  location: 'path' | 'query'
): Array<Record<string, unknown>> {
  const params: Array<Record<string, unknown>> = [];
  const properties = (schema as Record<string, unknown>).properties as
    | Record<string, TSchema>
    | undefined;
  const required = ((schema as Record<string, unknown>).required as string[]) ?? [];

  if (!properties) return params;

  for (const [name, prop] of Object.entries(properties)) {
    params.push({
      name,
      in: location,
      required: location === 'path' ? true : required.includes(name),
      description: (prop as Record<string, unknown>).description,
      schema: prop,
    });
  }

  return params;
}

/** Build OpenAPI request body from a TypeBox body schema */
function bodyToRequestBody(schema: TSchema): RequestBodyDef {
  return {
    required: true,
    content: {
      'application/json': {
        schema,
      },
    },
  };
}

/**
 * Generate the complete OpenAPI 3.1 document from all registered routes.
 */
export function generateOpenApiDocument(): Record<string, unknown> {
  const tagSet = new Map<string, string>();
  const tagDescriptions: Record<string, string> = {
    Health: 'Health check endpoints',
    Backups: 'Backup and restore operations',
    Settings: 'Backup-server settings management',
    Operations: 'Long-running operation tracking',
    Cloud: 'Cloud backup sync (Google Drive)',
  };

  for (const entry of registry) {
    for (const tag of entry.tags) {
      if (!tagSet.has(tag)) {
        tagSet.set(tag, tagDescriptions[tag] ?? '');
      }
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};

  for (const entry of registry) {
    const fullPath = toOpenApiPath(entry.prefix + entry.path);
    if (!paths[fullPath]) {
      paths[fullPath] = {};
    }

    const operation: Record<string, unknown> = {
      tags: entry.tags,
      summary: entry.spec.summary,
    };

    if (entry.spec.description) {
      operation.description = entry.spec.description;
    }

    if (entry.spec.deprecated) {
      operation.deprecated = true;
    }

    const parameters: Array<Record<string, unknown>> = [];
    if (entry.spec.params) {
      parameters.push(...schemaToParameters(entry.spec.params, 'path'));
    }
    if (entry.spec.query) {
      parameters.push(...schemaToParameters(entry.spec.query, 'query'));
    }
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (entry.spec.requestBody) {
      operation.requestBody = entry.spec.requestBody;
    } else if (entry.spec.body) {
      operation.requestBody = bodyToRequestBody(entry.spec.body);
    }

    if (entry.spec.responses) {
      const responses: Record<string, ResponseDef> = {};
      for (const [code, def] of Object.entries(entry.spec.responses)) {
        responses[String(code)] = def;
      }
      operation.responses = responses;
    } else {
      // Default response
      operation.responses = {
        200: { description: 'Success' },
        500: { description: 'Internal server error' },
      };
    }

    paths[fullPath][entry.method] = operation;
  }

  const schemas: Record<string, TSchema> = {};
  for (const [id, schema] of componentSchemas) {
    schemas[id] = schema;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'SignalK Backup Server API',
      version: packageJson.version || '0.0.1',
      description: `
API for managing SignalK server backups (local + cloud).

## Features
- **Backup & Restore** - Create, download, upload, and restore backups
- **Cloud Sync** - Sync the local Kopia repo to Google Drive via rclone
- **Settings** - Configure exclusions, retention, scheduling

## Authentication
The container is reachable only via signalk-container's loopback binding;
network-layer protection replaces in-app auth.

See the AsyncAPI specification at \`/api/asyncapi.json\` for SSE event schemas.
      `.trim(),
      contact: {
        name: 'SignalK',
        url: 'https://signalk.org',
      },
      license: {
        name: 'Apache 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0.html',
      },
    },
    servers: [
      {
        url: '/api',
        description: 'signalk-backup-server API (relative path)',
      },
    ],
    tags: [...tagSet.entries()].map(([name, description]) => ({
      name,
      ...(description ? { description } : {}),
    })),
    paths,
    ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
  };
}
