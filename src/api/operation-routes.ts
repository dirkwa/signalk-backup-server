/**
 * Operation tracking API routes
 *
 * Provides endpoints for querying ongoing and completed operations.
 * This allows the UI to reconnect to operations after navigation or refresh.
 */

import { type Request, type Response } from 'express';
import { operationTracker, type TrackedOperation } from '../services/operation-tracker.js';
import type { ApiResponse } from '../types/index.js';
import { createApiRouter } from './openapi-registry.js';

const api = createApiRouter('Operations');

/**
 * GET /api/operations/current
 * Get the current running operation (if any)
 * Used by UI on mount to check if there's an ongoing operation to reconnect to
 */
api.get(
  '/current',
  {
    summary: 'Get current operation',
    description:
      'Returns the currently running operation, if any. Used by UI to reconnect after navigation or refresh.',
    responses: {
      200: { description: 'Current operation or null' },
    },
  },
  (_req: Request, res: Response) => {
    const operation = operationTracker.getCurrentOperation();

    const response: ApiResponse<TrackedOperation | null> = {
      success: true,
      data: operation,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

/**
 * GET /api/operations/:id
 * Get a specific operation by ID
 */
api.get(
  '/:id',
  {
    summary: 'Get operation by ID',
    description: 'Retrieve a specific tracked operation by its ID',
    responses: {
      200: { description: 'Operation details' },
      404: { description: 'Operation not found' },
    },
  },
  (req: Request, res: Response) => {
    const id = req.params.id as string;
    const operation = operationTracker.get(id);

    if (!operation) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'OPERATION_NOT_FOUND',
          message: `Operation ${id} not found`,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(404).json(response);
      return;
    }

    const response: ApiResponse<TrackedOperation> = {
      success: true,
      data: operation,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

/**
 * GET /api/operations
 * Get all tracked operations (for debugging/admin)
 */
api.get(
  '/',
  {
    summary: 'List all operations',
    description: 'Get all tracked operations (for debugging/admin)',
    responses: {
      200: { description: 'List of all tracked operations' },
    },
  },
  (_req: Request, res: Response) => {
    const operations = operationTracker.getAll();

    const response: ApiResponse<TrackedOperation[]> = {
      success: true,
      data: operations,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

export const operationRouter = api.router;
