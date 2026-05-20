/**
 * TypeBox Validation Middleware
 *
 * Provides Express middleware for validating request body, params, and query
 * using TypeBox schemas. Returns consistent error responses for validation failures.
 */

import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import type { Request, Response, NextFunction } from 'express';

export interface ValidationSchemas {
  body?: TSchema;
  params?: TSchema;
  query?: TSchema;
}

/**
 * Creates Express middleware that validates request data against TypeBox schemas.
 *
 * @param schemas - Object containing optional TypeBox schemas for body, params, and query
 * @returns Express middleware function
 *
 * @example
 * router.post('/enable', validate({ body: enableHistorySchema }), handler);
 * router.get('/:id', validate({ params: idParamSchema }), handler);
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ path: string; message: string }> = [];

    try {
      if (schemas.body) {
        if (!Value.Check(schemas.body, req.body)) {
          const bodyErrors = [...Value.Errors(schemas.body, req.body)];
          errors.push(
            ...bodyErrors.map((e) => ({
              path: e.path || 'body',
              message: e.message,
            }))
          );
        } else {
          // Apply defaults and coercion
          req.body = Value.Default(schemas.body, req.body);
        }
      }

      if (schemas.params) {
        if (!Value.Check(schemas.params, req.params)) {
          const paramErrors = [...Value.Errors(schemas.params, req.params)];
          errors.push(
            ...paramErrors.map((e) => ({
              path: e.path ? `params${e.path}` : 'params',
              message: e.message,
            }))
          );
        } else {
          req.params = Value.Default(schemas.params, req.params) as typeof req.params;
        }
      }

      if (schemas.query) {
        if (!Value.Check(schemas.query, req.query)) {
          const queryErrors = [...Value.Errors(schemas.query, req.query)];
          errors.push(
            ...queryErrors.map((e) => ({
              path: e.path ? `query${e.path}` : 'query',
              message: e.message,
            }))
          );
        } else {
          // Express 5 made req.query a getter-only property, so plain
          // assignment throws. Define the property directly so routes
          // can still see TypeBox-defaulted values.
          const defaulted = Value.Default(schemas.query, req.query) as typeof req.query;
          Object.defineProperty(req, 'query', {
            value: defaulted,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
      }

      if (errors.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: errors,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    } catch (error) {
      // Handle unexpected validation errors
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [
            {
              path: 'unknown',
              message: error instanceof Error ? error.message : 'Validation failed',
            },
          ],
        },
        timestamp: new Date().toISOString(),
      });
    }
  };
}
