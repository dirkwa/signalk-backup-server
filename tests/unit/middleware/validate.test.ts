// Regression coverage for the TypeBox validation middleware. The
// motivating bug: Express 5 made req.query a getter-only property, so
// a plain `req.query = ...` after TypeBox defaulting throws "Cannot
// set property query of #<IncomingMessage>". Routes that declared a
// query schema therefore 400'd on every request.

import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { Request, Response, NextFunction } from 'express';
import { validate } from '../../../src/middleware/validate.js';

interface ValidatePayload {
  status: number;
  body?: unknown;
}

function runMiddleware(opts: {
  query?: unknown;
  body?: unknown;
  params?: unknown;
  queryGetterOnly?: boolean;
  schemas: Parameters<typeof validate>[0];
}): { result: 'next' | ValidatePayload; req: Request } {
  const req = {
    body: opts.body,
    params: opts.params,
  } as Partial<Request> as Request;

  if (opts.queryGetterOnly) {
    // Reproduce Express 5's req.query: defined with a getter only,
    // so plain assignment throws "Cannot set property query".
    Object.defineProperty(req, 'query', {
      get: () => opts.query,
      configurable: true,
      enumerable: true,
    });
  } else {
    (req as { query?: unknown }).query = opts.query;
  }

  let captured: ValidatePayload | undefined;
  const res = {
    status: vi.fn().mockImplementation((code: number) => {
      captured = { status: code };
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      if (captured) captured.body = body;
      return res;
    }),
  } as unknown as Response;

  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  validate(opts.schemas)(req, res, next);

  if (nextCalled) return { result: 'next', req };
  if (!captured) {
    throw new Error('middleware neither called next() nor sent a response');
  }
  return { result: captured, req };
}

describe('validate middleware', () => {
  describe('query schema against an Express-5-style getter-only req.query', () => {
    const querySchema = Type.Object({
      path: Type.Optional(Type.String()),
    });

    it('passes through valid query without throwing on the read-only getter', () => {
      const { result } = runMiddleware({
        query: { path: 'plugin-config-data/foo' },
        queryGetterOnly: true,
        schemas: { query: querySchema },
      });
      expect(result).toBe('next');
    });

    it('passes through an empty query when path is optional', () => {
      const { result } = runMiddleware({
        query: {},
        queryGetterOnly: true,
        schemas: { query: querySchema },
      });
      expect(result).toBe('next');
    });

    it('still returns 400 on invalid query (no silent pass-through)', () => {
      const strict = Type.Object({
        limit: Type.Number(),
      });
      const { result } = runMiddleware({
        query: { limit: 'not a number' },
        queryGetterOnly: true,
        schemas: { query: strict },
      });
      expect(result).not.toBe('next');
      const payload = result as ValidatePayload;
      expect(payload.status).toBe(400);
      const body = payload.body as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('body / params still work as before', () => {
    it('passes through a valid body', () => {
      const schema = Type.Object({ name: Type.String() });
      const { result } = runMiddleware({
        body: { name: 'ok' },
        schemas: { body: schema },
      });
      expect(result).toBe('next');
    });

    it('rejects an invalid body with 400', () => {
      const schema = Type.Object({ name: Type.String() });
      const { result } = runMiddleware({
        body: { name: 42 },
        schemas: { body: schema },
      });
      const payload = result as ValidatePayload;
      expect(payload.status).toBe(400);
    });
  });
});
