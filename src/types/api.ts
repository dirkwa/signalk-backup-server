/**
 * API response and WebSocket types
 */

/** Standard API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

/** API error details */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** Paginated response */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/** WebSocket message types */
export type WsMessageType =
  | 'log'
  | 'container_status'
  | 'update_progress'
  | 'health_status'
  | 'backup_progress';

/** WebSocket message wrapper */
export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
}

/** Log message payload */
export interface LogMessage {
  stream: 'stdout' | 'stderr';
  content: string;
  timestamp: string;
}

/** Container status change payload */
export interface ContainerStatusMessage {
  containerId: string;
  containerName: string;
  previousStatus: string;
  currentStatus: string;
}

/** Update progress payload */
export interface UpdateProgressMessage {
  stage: 'downloading' | 'applying' | 'health_check' | 'rollback';
  progress: number;
  message: string;
}

/** Health status payload */
export interface HealthStatusMessage {
  containerId: string;
  containerName: string;
  status: 'healthy' | 'unhealthy' | 'starting';
  checkOutput?: string;
}

/** Backup progress payload */
export interface BackupProgressMessage {
  backupId: string;
  operation: 'backup' | 'restore';
  progress: number;
  message: string;
}

/** WebSocket client subscription */
export interface WsSubscription {
  type: 'logs' | 'status' | 'updates';
  containerId?: string;
}

/** WebSocket client command */
export interface WsCommand {
  action: 'subscribe' | 'unsubscribe';
  subscription: WsSubscription;
}
