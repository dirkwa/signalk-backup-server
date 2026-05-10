/**
 * Operation Tracker Service
 *
 * Tracks ongoing long-running operations (image pulls, version switches)
 * so that the UI can reconnect to them after navigation or page refresh.
 */

import pino from 'pino';

const logger = pino({ name: 'operation-tracker' });

/** Types of operations that can be tracked */
export type OperationType = 'pull' | 'switch';

/** Operation status */
export type OperationStatus = 'pending' | 'running' | 'complete' | 'error';

/** Progress update for tracked operations */
export interface OperationProgress {
  /** Current step (e.g., 'pulling', 'stopping', 'creating') */
  step: string;
  /** Human-readable message */
  message: string;
  /** Progress percentage (0-100) for pull operations */
  percent?: number;
}

/** Tracked operation state */
export interface TrackedOperation {
  /** Unique operation ID */
  id: string;
  /** Type of operation */
  type: OperationType;
  /** Target (e.g., tag for pull, targetTag for switch) */
  target: string;
  /** Current status */
  status: OperationStatus;
  /** When the operation started */
  startedAt: string;
  /** When the operation completed (if finished) */
  completedAt?: string;
  /** Latest progress update */
  progress?: OperationProgress;
  /** Error message if status is 'error' */
  error?: string;
  /** Result data (for completed operations) */
  result?: unknown;
}

/**
 * Operation Tracker - singleton service for tracking long-running operations
 */
class OperationTracker {
  /** Currently tracked operations (in-memory, cleared on restart) */
  private operations = new Map<string, TrackedOperation>();

  /** Maximum number of completed operations to keep (for history) */
  private readonly maxCompletedOps = 10;

  /**
   * Generate a unique operation ID
   */
  private generateId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Start tracking a new operation
   */
  start(type: OperationType, target: string): string {
    const id = this.generateId();

    const operation: TrackedOperation = {
      id,
      type,
      target,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: {
        step: 'starting',
        message: `Starting ${type} operation for ${target}...`,
      },
    };

    this.operations.set(id, operation);
    logger.info({ id, type, target }, 'Started tracking operation');

    this.cleanup();
    return id;
  }

  /**
   * Update operation progress
   */
  updateProgress(id: string, progress: OperationProgress): void {
    const operation = this.operations.get(id);
    if (!operation) {
      logger.warn({ id }, 'Attempted to update progress for unknown operation');
      return;
    }

    operation.progress = progress;
    logger.debug({ id, progress }, 'Updated operation progress');
  }

  /**
   * Mark operation as complete
   */
  complete(id: string, result?: unknown): void {
    const operation = this.operations.get(id);
    if (!operation) {
      logger.warn({ id }, 'Attempted to complete unknown operation');
      return;
    }

    operation.status = 'complete';
    operation.completedAt = new Date().toISOString();
    operation.progress = {
      step: 'complete',
      message: 'Operation completed successfully',
      percent: 100,
    };
    if (result !== undefined) {
      operation.result = result;
    }

    logger.info({ id, type: operation.type, target: operation.target }, 'Operation completed');
  }

  /**
   * Mark operation as failed
   */
  fail(id: string, error: string): void {
    const operation = this.operations.get(id);
    if (!operation) {
      logger.warn({ id }, 'Attempted to fail unknown operation');
      return;
    }

    operation.status = 'error';
    operation.completedAt = new Date().toISOString();
    operation.error = error;
    operation.progress = {
      step: 'error',
      message: error,
    };

    logger.error({ id, type: operation.type, target: operation.target, error }, 'Operation failed');
  }

  /**
   * Get operation by ID
   */
  get(id: string): TrackedOperation | undefined {
    return this.operations.get(id);
  }

  /**
   * Get current running operation (if any)
   * For UI reconnection - returns the most recent running operation
   */
  getCurrentOperation(): TrackedOperation | null {
    let latest: TrackedOperation | null = null;

    for (const op of this.operations.values()) {
      if (op.status === 'running') {
        if (!latest || new Date(op.startedAt) > new Date(latest.startedAt)) {
          latest = op;
        }
      }
    }

    return latest;
  }

  /**
   * Get operation by type and target (for checking if already running)
   */
  getByTypeAndTarget(type: OperationType, target: string): TrackedOperation | undefined {
    for (const op of this.operations.values()) {
      if (op.type === type && op.target === target && op.status === 'running') {
        return op;
      }
    }
    return undefined;
  }

  /**
   * Get all operations (for debugging/admin)
   */
  getAll(): TrackedOperation[] {
    return Array.from(this.operations.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  /**
   * Cleanup old completed operations
   */
  private cleanup(): void {
    const completed = Array.from(this.operations.values())
      .filter((op) => op.status === 'complete' || op.status === 'error')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Remove old completed operations beyond the limit
    if (completed.length > this.maxCompletedOps) {
      const toRemove = completed.slice(this.maxCompletedOps);
      for (const op of toRemove) {
        this.operations.delete(op.id);
        logger.debug({ id: op.id }, 'Cleaned up old operation');
      }
    }
  }
}

/** Singleton instance */
export const operationTracker = new OperationTracker();
