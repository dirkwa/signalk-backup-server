/**
 * OpenAPI Registry Tests
 */

import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  createApiRouter,
  setRoutePrefixByTag,
  generateOpenApiDocument,
} from '../../../src/api/openapi-registry.js';

// Note: The registry is a global singleton (module-level state).
// Routes registered in other test files or source imports won't interfere
// because vitest isolates modules. But routes registered within this file
// accumulate across tests in the same describe block.

describe('openapi-registry', () => {
  describe('createApiRouter', () => {
    it('creates a router with the expected interface', () => {
      const api = createApiRouter('TestTag');
      expect(api.router).toBeDefined();
      expect(api.defaultTag).toBe('TestTag');
      expect(typeof api.get).toBe('function');
      expect(typeof api.post).toBe('function');
      expect(typeof api.put).toBe('function');
      expect(typeof api.delete).toBe('function');
      expect(typeof api.patch).toBe('function');
      expect(typeof api.setPrefix).toBe('function');
    });

    it('registers routes that appear in generated OpenAPI doc', () => {
      const api = createApiRouter('TestRoutes');

      api.get(
        '/items',
        {
          summary: 'List items',
          responses: { 200: { description: 'Item list' } },
        },
        (_req, res) => res.json([])
      );

      setRoutePrefixByTag('TestRoutes', '/api/test');
      const doc = generateOpenApiDocument() as {
        paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
      };

      expect(doc.paths['/api/test/items']).toBeDefined();
      expect(doc.paths['/api/test/items'].get).toBeDefined();
      expect(doc.paths['/api/test/items'].get.summary).toBe('List items');
      expect(doc.paths['/api/test/items'].get.tags).toContain('TestRoutes');
    });

    it('registers POST routes with body schema', () => {
      const api = createApiRouter('PostTest');
      const bodySchema = Type.Object({ name: Type.String() }, { $id: 'PostTestBody' });

      api.post(
        '/create',
        {
          summary: 'Create item',
          body: bodySchema,
          responses: { 200: { description: 'Created' } },
        },
        (_req, res) => res.json({})
      );

      setRoutePrefixByTag('PostTest', '/api/post');
      const doc = generateOpenApiDocument() as {
        paths: Record<
          string,
          Record<string, { requestBody?: { content: Record<string, unknown> } }>
        >;
        components?: { schemas: Record<string, unknown> };
      };

      const postOp = doc.paths['/api/post/create']?.post;
      expect(postOp).toBeDefined();
      expect(postOp?.requestBody).toBeDefined();
      expect(postOp?.requestBody?.content['application/json']).toBeDefined();
    });
  });

  describe('path conversion', () => {
    it('converts Express :param to OpenAPI {param}', () => {
      const api = createApiRouter('ParamTest');

      api.get(
        '/items/:id',
        {
          summary: 'Get item',
          params: Type.Object({ id: Type.String() }),
          responses: { 200: { description: 'Item' } },
        },
        (_req, res) => res.json({})
      );

      setRoutePrefixByTag('ParamTest', '/api/params');
      const doc = generateOpenApiDocument() as {
        paths: Record<string, Record<string, unknown>>;
      };

      expect(doc.paths['/api/params/items/{id}']).toBeDefined();
      expect(doc.paths['/api/params/items/:id']).toBeUndefined();
    });
  });

  describe('generateOpenApiDocument', () => {
    it('produces a valid OpenAPI 3.1 structure', () => {
      const doc = generateOpenApiDocument() as Record<string, unknown>;

      expect(doc.openapi).toBe('3.1.0');
      expect(doc.info).toBeDefined();
      expect((doc.info as Record<string, unknown>).title).toBe('SignalK Backup Server API');
      expect(doc.paths).toBeDefined();
      expect(doc.tags).toBeDefined();
      expect(Array.isArray(doc.tags)).toBe(true);
    });

    it('includes component schemas for TypeBox schemas with $id', () => {
      const api = createApiRouter('SchemaTest');
      const schema = Type.Object({ value: Type.Number() }, { $id: 'TestComponentSchema' });

      api.post(
        '/schema-test',
        {
          summary: 'Schema test',
          body: schema,
          responses: { 200: { description: 'OK' } },
        },
        (_req, res) => res.json({})
      );

      setRoutePrefixByTag('SchemaTest', '/api/schema');
      const doc = generateOpenApiDocument() as {
        components?: { schemas: Record<string, unknown> };
      };

      expect(doc.components?.schemas?.TestComponentSchema).toBeDefined();
    });

    it('generates parameters for query schemas', () => {
      const api = createApiRouter('QueryTest');
      const querySchema = Type.Object({
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
      });

      api.get(
        '/paginated',
        {
          summary: 'Paginated list',
          query: querySchema,
          responses: { 200: { description: 'List' } },
        },
        (_req, res) => res.json([])
      );

      setRoutePrefixByTag('QueryTest', '/api/query');
      const doc = generateOpenApiDocument() as {
        paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
      };

      const params = doc.paths['/api/query/paginated']?.get?.parameters;
      expect(params).toBeDefined();
      expect(params!.length).toBe(2);
      expect(params!.find((p) => p.name === 'limit')?.in).toBe('query');
      expect(params!.find((p) => p.name === 'offset')?.in).toBe('query');
    });

    it('supports multiple HTTP methods on the same path', () => {
      const api = createApiRouter('MultiMethod');

      api.get(
        '/resource',
        { summary: 'Get resource', responses: { 200: { description: 'OK' } } },
        (_req, res) => res.json({})
      );
      api.put(
        '/resource',
        { summary: 'Update resource', responses: { 200: { description: 'Updated' } } },
        (_req, res) => res.json({})
      );
      api.delete(
        '/resource',
        { summary: 'Delete resource', responses: { 200: { description: 'Deleted' } } },
        (_req, res) => res.json({})
      );

      setRoutePrefixByTag('MultiMethod', '/api/multi');
      const doc = generateOpenApiDocument() as {
        paths: Record<string, Record<string, unknown>>;
      };

      const resource = doc.paths['/api/multi/resource'];
      expect(resource?.get).toBeDefined();
      expect(resource?.put).toBeDefined();
      expect(resource?.delete).toBeDefined();
    });
  });

  describe('setRoutePrefixByTag', () => {
    it('sets prefix for routes matching the tag', () => {
      const api = createApiRouter('PrefixTest');

      api.get(
        '/data',
        { summary: 'Get data', responses: { 200: { description: 'Data' } } },
        (_req, res) => res.json({})
      );

      setRoutePrefixByTag('PrefixTest', '/api/prefixed');
      const doc = generateOpenApiDocument() as {
        paths: Record<string, unknown>;
      };

      expect(doc.paths['/api/prefixed/data']).toBeDefined();
    });
  });
});
