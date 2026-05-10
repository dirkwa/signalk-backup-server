import { apiUrl } from '../../api';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Button,
  Spinner,
  Alert,
  CloseButton,
  Badge,
  Form,
  ProgressBar,
  Nav,
  Tab,
  Modal,
  Row,
  Col,
} from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDownload,
  faTrash,
  faPlusCircle,
  faUpload,
  faCheckCircle,
  faExclamationCircle,
  faClock,
  faCalendarDay,
  faCalendarWeek,
  faPowerOff,
  faHand,
  faSync,
  faUndo,
  faPlug,
  faCloud,
  faCloudArrowUp,
  faCloudArrowDown,
  faKey,
  faLink,
  faLinkSlash,
  faWifi,
  faEye,
  faEyeSlash,
  faCopy,
  faFolder,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

// Types
interface BackupMetadata {
  id: string;
  createdAt: string;
  version: {
    tag: string;
    fullRef: string;
  };
  type: 'hourly' | 'daily' | 'weekly' | 'startup' | 'manual' | 'pre-update' | 'pre-restore';
  size: number;
  path: string;
  description?: string;
  checksum: string;
  includesPlugins: boolean;
  includesPluginData?: boolean;
}

interface GroupedBackups {
  hourly: BackupMetadata[];
  daily: BackupMetadata[];
  weekly: BackupMetadata[];
  startup: BackupMetadata[];
  manual: BackupMetadata[];
  other: BackupMetadata[];
}

interface BackupsResponse {
  backups: BackupMetadata[];
  grouped: GroupedBackups;
}

interface SchedulerStatus {
  enabled: boolean;
  lastBackup: string | null;
  nextBackups: {
    hourly: string | null;
    daily: string | null;
    weekly: string | null;
  };
  backupCounts: {
    hourly: number;
    daily: number;
    weekly: number;
    startup: number;
    manual: number;
    total: number;
  };
}

interface StorageStats {
  totalSize: number;
  countByType: Record<string, number>;
  sizeByType: Record<string, number>;
  oldestBackup: string | null;
  newestBackup: string | null;
}

interface RestoreProgress {
  state: string;
  progress: number;
  statusMessage: string;
  error?: string;
}

// API functions
const fetchBackups = async (): Promise<BackupsResponse> => {
  const res = await fetch(apiUrl('/api/backups'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch backups');
  return data.data;
};

const fetchSchedulerStatus = async (): Promise<SchedulerStatus> => {
  const res = await fetch(apiUrl('/api/backups/scheduler'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch scheduler status');
  return data.data;
};

const fetchStorageStats = async (): Promise<StorageStats> => {
  const res = await fetch(apiUrl('/api/backups/storage'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch storage stats');
  return data.data;
};

const createBackup = async (options: { description?: string }): Promise<BackupMetadata> => {
  const res = await fetch(apiUrl('/api/backups'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...options, type: 'manual' }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to create backup');
  return data.data.backup;
};

const deleteBackup = async (id: string): Promise<void> => {
  const res = await fetch(apiUrl(`/api/backups/${id}`), { method: 'DELETE' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to delete backup');
};

const uploadBackup = async (file: File, description?: string): Promise<BackupMetadata> => {
  const formData = new FormData();
  formData.append('file', file);
  if (description) formData.append('description', description);
  formData.append('restoreImmediately', 'false');

  const res = await fetch(apiUrl('/api/backups/upload'), {
    method: 'POST',
    body: formData,
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to upload backup');
  return data.data.backup;
};

const startRestore = async (id: string): Promise<void> => {
  const res = await fetch(apiUrl(`/api/backups/${id}/restore`), { method: 'POST' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to start restore');
};

// NOTE: signalk-backup-server uses a simple "restore-pending" marker model rather
// than the rich in-progress progress feed used by Keeper. We poll
// /api/backups/restore/pending and treat any non-null payload as "still pending".
// TODO: confirm server-side route exists (currently only restoreService writes a
// marker file; an HTTP route may need to be added).
const fetchRestoreProgress = async (): Promise<RestoreProgress | null> => {
  const res = await fetch(apiUrl('/api/backups/restore/pending'));
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.success) return null;
  // The pending marker may not include progress fields; coerce to a minimal shape
  // so the existing UI can render a generic "restore in progress" banner.
  if (data.data === null || data.data === undefined) return null;
  return {
    state: data.data.state || 'pending',
    progress: data.data.progress ?? 0,
    statusMessage: data.data.statusMessage || 'Restore pending — waiting for SignalK to restart...',
    error: data.data.error,
  };
};

const resetRestoreState = async (): Promise<void> => {
  await fetch(apiUrl('/api/backups/restore/reset'), { method: 'POST' });
};

// Cloud backup types
interface SyncProgress {
  totalBytes: number;
  processedBlobs?: number;
  totalBlobs?: number;
  processedBytes?: number;
}

interface CloudSyncStatus {
  connected: boolean;
  configured: boolean;
  syncing: boolean;
  syncMode: 'manual' | 'after_backup' | 'scheduled' | null;
  syncFrequency: 'daily' | 'weekly' | null;
  lastSync: string | null;
  lastSyncError: string | null;
  internetAvailable: boolean | null;
  email?: string;
  syncProgress?: SyncProgress;
}

interface PasswordStatus {
  hasCustomPassword: boolean;
  password?: string;
}

// Cloud API functions
const fetchCloudStatus = async (): Promise<CloudSyncStatus> => {
  const res = await fetch(apiUrl('/api/cloud/status'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch cloud status');
  return data.data;
};

const connectGDrive = async (): Promise<{ authUrl: string }> => {
  const res = await fetch(apiUrl('/api/cloud/gdrive/connect'), { method: 'POST' });
  const data = await res.json();
  if (!data.success)
    throw new Error(data.error?.message || 'Failed to start Google Drive connection');
  return data.data;
};

const fetchAuthState = async (): Promise<{
  state: string;
  authUrl: string | null;
  error: string | null;
}> => {
  const res = await fetch(apiUrl('/api/cloud/gdrive/auth-state'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to get auth state');
  return data.data;
};

const cancelGDriveAuth = async (): Promise<void> => {
  await fetch(apiUrl('/api/cloud/gdrive/cancel'), { method: 'POST' });
};

const forwardAuthCallback = async (url: string): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/gdrive/auth-callback'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to forward callback');
};

const disconnectGDrive = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/gdrive/disconnect'), { method: 'POST' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to disconnect Google Drive');
};

const triggerCloudSync = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/sync'), { method: 'POST' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to start cloud sync');
};

const cancelCloudSync = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/sync/cancel'), { method: 'POST' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to cancel sync');
};

const updateCloudConfig = async (config: {
  syncMode?: string;
  syncFrequency?: string;
}): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to update cloud config');
};

interface DataDirEntry {
  name: string;
  size: number;
  excluded: boolean;
  type?: 'dir' | 'history';
}

interface PluginDataDirEntry {
  name: string;
  size: number;
  excluded: boolean;
  lockedExcluded?: boolean;
  lockReason?: string;
}

const fetchDataDirs = async (): Promise<DataDirEntry[]> => {
  const res = await fetch(apiUrl('/api/backups/data-dirs'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch data directories');
  return data.data;
};

const fetchPluginDataDirs = async (): Promise<PluginDataDirEntry[]> => {
  const res = await fetch(apiUrl('/api/backups/plugin-data-dirs'));
  const data = await res.json();
  if (!data.success)
    throw new Error(data.error?.message || 'Failed to fetch plugin data directories');
  return data.data;
};

const updateExclusions = async (exclusions: string[]): Promise<void> => {
  const res = await fetch(apiUrl('/api/backups/exclusions'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exclusions }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to update exclusions');
};

const fetchPasswordStatus = async (): Promise<PasswordStatus> => {
  const res = await fetch(apiUrl('/api/backups/password'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch password');
  return data.data;
};

// Cloud restore types
interface CloudInstall {
  folder: string;
  info?: {
    installName?: string;
    installId?: string;
    vesselName?: string;
    hardware?: string;
    lastUpdated?: string;
  };
}

interface CloudRestorePrepareResult {
  phase: string;
  snapshots: BackupMetadata[];
  error?: string;
}

type CloudRestoreStep =
  | 'select-install'
  | 'enter-password'
  | 'preparing'
  | 'select-snapshot'
  | 'confirm'
  | 'restoring';

// Cloud restore API functions
const fetchCloudInstalls = async (): Promise<CloudInstall[]> => {
  const res = await fetch(apiUrl('/api/cloud/installs'));
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to fetch installations');
  return data.data;
};

const prepareCloudRestore = async (
  folder: string,
  password?: string
): Promise<CloudRestorePrepareResult> => {
  const res = await fetch(apiUrl('/api/cloud/restore/prepare'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, password: password || undefined }),
  });
  const data = await res.json();
  if (!data.success && !data.data)
    throw new Error(data.error?.message || 'Failed to prepare cloud restore');
  return data.data;
};

const startCloudRestore = async (snapshotId: string, mode: 'restore' | 'clone'): Promise<void> => {
  const res = await fetch(apiUrl('/api/cloud/restore/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId, mode }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to start cloud restore');
};

const resetCloudRestoreState = async (): Promise<void> => {
  await fetch(apiUrl('/api/cloud/restore/reset'), { method: 'POST' });
};

// Helper functions
const formatDate = (dateStr: string): string => {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
};

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatRelativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
};

const getTypeIcon = (type: string): IconDefinition => {
  switch (type) {
    case 'hourly':
      return faClock;
    case 'daily':
      return faCalendarDay;
    case 'weekly':
      return faCalendarWeek;
    case 'startup':
      return faPowerOff;
    case 'manual':
      return faHand;
    default:
      return faClock;
  }
};

const getTypeLabel = (type: string) => {
  switch (type) {
    case 'hourly':
      return 'Hourly';
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'startup':
      return 'Startup';
    case 'manual':
      return 'Manual';
    case 'pre-update':
      return 'Pre-Update';
    case 'pre-restore':
      return 'Pre-Restore';
    default:
      return type;
  }
};

const getRestoreStateMessage = (state: string): string => {
  switch (state) {
    case 'idle':
      return 'Ready';
    case 'preparing':
      return 'Creating safety backup...';
    case 'extracting':
      return 'Extracting backup files...';
    case 'installing':
      return 'Installing plugins...';
    case 'restarting':
      return 'Restarting SignalK...';
    case 'verifying':
      return 'Verifying health...';
    case 'completed':
      return 'Restore completed successfully!';
    case 'failed':
      return 'Restore failed';
    case 'rollingBack':
      return 'Rolling back to previous state...';
    case 'rolledBack':
      return 'Rolled back to previous state';
    default:
      return state;
  }
};

// BackupRow component
const BackupRow = ({
  backup,
  onDelete,
  onRestore,
  isDeleting,
  isRestoring,
}: {
  backup: BackupMetadata;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  isDeleting: boolean;
  isRestoring: boolean;
}) => {
  const handleDownload = () => {
    window.open(`/api/backups/${backup.id}/download`, '_blank');
  };

  return (
    <div className="backup-row">
      <Row className="align-items-center g-2">
        <Col xs="auto">
          <div className="backup-icon">
            <FontAwesomeIcon icon={getTypeIcon(backup.type)} />
          </div>
        </Col>
        <Col>
          <div className="backup-info">
            <div className="backup-title">
              {formatRelativeTime(backup.createdAt)}
              <Badge bg="secondary" className="ms-2 backup-type-label">
                {getTypeLabel(backup.type)}
              </Badge>
            </div>
            <div className="backup-meta">
              {formatSize(backup.size)} &bull; v{backup.version.tag}
              {backup.description && <span> &bull; {backup.description}</span>}
            </div>
          </div>
        </Col>
        <Col xs="auto">
          <Button
            variant="link"
            size="sm"
            className="p-1"
            aria-label="Restore"
            onClick={() => onRestore(backup.id)}
            disabled={isRestoring}
            title="Restore this backup"
          >
            <FontAwesomeIcon icon={faUndo} />
          </Button>
          <Button
            variant="link"
            size="sm"
            className="p-1"
            aria-label="Download"
            onClick={handleDownload}
            title="Download backup"
          >
            <FontAwesomeIcon icon={faDownload} />
          </Button>
          <Button
            variant="link"
            size="sm"
            className="p-1"
            aria-label="Delete"
            onClick={() => onDelete(backup.id)}
            disabled={isDeleting}
            title="Delete backup"
          >
            <FontAwesomeIcon icon={faTrash} />
          </Button>
        </Col>
      </Row>
    </div>
  );
};

// Main component
const isLocalAccess = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const isDesktopOS = /Macintosh|Windows/.test(navigator.userAgent);

const BackupsPage = () => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Create backup modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createDescription, setCreateDescription] = useState('');

  // Upload modal state
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadDescription, setUploadDescription] = useState('');

  // Delete confirm state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Restore state
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cloud backup state
  const [showPassword, setShowPassword] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [authPolling, setAuthPolling] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [showCallbackFallback, setShowCallbackFallback] = useState(false);
  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authStartTimeRef = useRef<number>(0);
  const authWindowRef = useRef<Window | null>(null);

  // Cloud restore state
  const [showCloudRestore, setShowCloudRestore] = useState(false);
  const [cloudRestoreStep, setCloudRestoreStep] = useState<CloudRestoreStep>('select-install');
  const [cloudInstalls, setCloudInstalls] = useState<CloudInstall[]>([]);
  const [selectedInstall, setSelectedInstall] = useState<CloudInstall | null>(null);
  const [cloudRestorePassword, setCloudRestorePassword] = useState('');
  const [cloudSnapshots, setCloudSnapshots] = useState<BackupMetadata[]>([]);
  const [selectedCloudSnapshot, setSelectedCloudSnapshot] = useState<string | null>(null);
  const [cloudRestoreMode, setCloudRestoreMode] = useState<'restore' | 'clone'>('restore');
  const [cloudRestoreLoading, setCloudRestoreLoading] = useState(false);
  const [cloudRestoreError, setCloudRestoreError] = useState<string | null>(null);

  // Exclusion deferred save state
  const [pendingDirs, setPendingDirs] = useState<DataDirEntry[] | null>(null);
  const [showExclusionConfirm, setShowExclusionConfirm] = useState(false);

  // Check if we just returned from a restore (URL has ?restored= param)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('restored')) {
      setSuccess('Backup restored successfully! Keeper has restarted.');
      // Clean up the URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Queries
  const {
    data: backupsData,
    isLoading: backupsLoading,
    refetch: refetchBackups,
  } = useQuery({
    queryKey: ['backups'],
    queryFn: fetchBackups,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  const { data: schedulerStatus, isLoading: schedulerLoading } = useQuery({
    queryKey: ['backupScheduler'],
    queryFn: fetchSchedulerStatus,
    staleTime: 30000,
  });

  const { data: storageStats } = useQuery({
    queryKey: ['backupStorage'],
    queryFn: fetchStorageStats,
    staleTime: 30000,
  });

  // Cloud backup queries
  const { data: cloudStatus, refetch: refetchCloud } = useQuery({
    queryKey: ['cloudStatus'],
    queryFn: fetchCloudStatus,
    staleTime: 10000,
    refetchInterval: (query) => {
      const data = query.state.data as CloudSyncStatus | undefined;
      return data?.syncing ? 5000 : 30000;
    },
  });

  const { data: passwordStatus } = useQuery({
    queryKey: ['passwordStatus'],
    queryFn: fetchPasswordStatus,
    staleTime: 60000,
  });

  const { data: dataDirs, isLoading: dataDirsLoading } = useQuery({
    queryKey: ['dataDirs'],
    queryFn: fetchDataDirs,
    staleTime: 60000,
  });

  const { data: pluginDataDirs, isLoading: pluginDataDirsLoading } = useQuery({
    queryKey: ['pluginDataDirs'],
    queryFn: fetchPluginDataDirs,
    staleTime: 60000,
  });

  const exclusionMutation = useMutation({
    mutationFn: updateExclusions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataDirs'] });
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      queryClient.invalidateQueries({ queryKey: ['backupStorage'] });
      setPendingDirs(null);
    },
    onError: (err: Error) => {
      setError(err.message);
      setPendingDirs(null);
    },
  });

  // Cleanup auth polling on unmount
  useEffect(() => {
    return () => {
      if (authPollRef.current) {
        clearInterval(authPollRef.current);
      }
    };
  }, []);

  // Mutations
  const createMutation = useMutation({
    mutationFn: createBackup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      queryClient.invalidateQueries({ queryKey: ['backupStorage'] });
      setCreateModalOpen(false);
      setCreateDescription('');
      setSuccess('Backup created successfully');
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBackup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      queryClient.invalidateQueries({ queryKey: ['backupStorage'] });
      setDeleteConfirmId(null);
      setSuccess('Backup deleted');
    },
    onError: (err: Error) => {
      setError(err.message);
      setDeleteConfirmId(null);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (params: { file: File; description?: string }) =>
      uploadBackup(params.file, params.description),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      queryClient.invalidateQueries({ queryKey: ['backupStorage'] });
      setUploadModalOpen(false);
      setUploadFile(null);
      setUploadDescription('');
      setSuccess('Backup uploaded successfully');
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: startRestore,
    onSuccess: () => {
      setRestoreConfirmId(null);
      setRestoreInProgress(true);
      setReconnecting(false);
      setReconnectAttempts(0);
      // Start polling for progress
      startProgressPolling();
    },
    onError: (err: Error) => {
      console.error('[Restore] onError:', err.message);
      setError(err.message);
      setRestoreConfirmId(null);
    },
  });

  // Cloud mutations
  const connectMutation = useMutation({
    mutationFn: connectGDrive,
    onSuccess: (data) => {
      // Navigate the pre-opened window (opened in onClick to preserve user gesture)
      if (authWindowRef.current && !authWindowRef.current.closed) {
        authWindowRef.current.location.href = data.authUrl;
      } else {
        window.open(data.authUrl, '_blank', isDesktopOS ? undefined : 'width=600,height=700');
      }
      setAuthPolling(true);
      setCallbackUrl('');
      // On macOS/Windows the OAuth redirect to 127.0.0.1:53682 can't reach
      // rclone inside the Podman VM, so show the callback fallback immediately
      setShowCallbackFallback(isDesktopOS);
      authStartTimeRef.current = Date.now();
      if (authPollRef.current) clearInterval(authPollRef.current);
      authPollRef.current = setInterval(async () => {
        try {
          const state = await fetchAuthState();
          if (state.state === 'completed') {
            if (authPollRef.current) clearInterval(authPollRef.current);
            authPollRef.current = null;
            setAuthPolling(false);
            setShowCallbackFallback(false);
            queryClient.invalidateQueries({ queryKey: ['cloudStatus'] });
            setSuccess('Google Drive connected successfully!');
          } else if (state.state === 'failed') {
            if (authPollRef.current) clearInterval(authPollRef.current);
            authPollRef.current = null;
            setAuthPolling(false);
            setShowCallbackFallback(false);
            setError(state.error || 'Authorization failed');
          } else if (Date.now() - authStartTimeRef.current > 15000) {
            // After 15s, show fallback for remote users on Linux
            setShowCallbackFallback(true);
          }
        } catch {
          // Ignore poll errors
        }
      }, 2000);
    },
    onError: (err: Error) => {
      if (authWindowRef.current && !authWindowRef.current.closed) {
        authWindowRef.current.close();
      }
      setError(err.message);
    },
  });

  const handleCancelAuth = useCallback(async () => {
    if (authPollRef.current) {
      clearInterval(authPollRef.current);
      authPollRef.current = null;
    }
    setAuthPolling(false);
    setShowCallbackFallback(false);
    setCallbackUrl('');
    try {
      await cancelGDriveAuth();
    } catch {
      // Ignore cancel errors
    }
  }, []);

  const handleForwardCallback = useCallback(async () => {
    if (!callbackUrl.trim()) return;
    try {
      await forwardAuthCallback(callbackUrl.trim());
      // Auth state polling will pick up the completion
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forward callback');
    }
  }, [callbackUrl]);

  const disconnectMutation = useMutation({
    mutationFn: disconnectGDrive,
    onSuccess: () => {
      setDisconnectConfirm(false);
      setSuccess('Google Drive disconnected');
    },
    onError: (err: Error) => {
      setError(err.message);
      setDisconnectConfirm(false);
    },
    onSettled: () => {
      // Always reload — the backend may have disconnected even if the proxy timed out
      queryClient.invalidateQueries({ queryKey: ['cloudStatus'] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: triggerCloudSync,
    onMutate: () => {
      // Optimistically show syncing state immediately
      queryClient.setQueryData(['cloudStatus'], (old: CloudSyncStatus | undefined) =>
        old ? { ...old, syncing: true } : old
      );
    },
    onSuccess: () => {
      setSuccess('Cloud sync started');
      // refetchInterval will poll at 5s while syncing
    },
    onError: (err: Error) => {
      setError(err.message);
      // Revert optimistic update
      refetchCloud();
    },
  });

  const cancelSyncMutation = useMutation({
    mutationFn: cancelCloudSync,
    onSuccess: () => {
      queryClient.setQueryData(['cloudStatus'], (old: CloudSyncStatus | undefined) =>
        old ? { ...old, syncing: false } : old
      );
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const configMutation = useMutation({
    mutationFn: updateCloudConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cloudStatus'] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  // Cloud restore handlers
  const openCloudRestore = useCallback(async () => {
    setCloudRestoreError(null);
    setCloudRestoreStep('select-install');
    setSelectedInstall(null);
    setCloudRestorePassword('');
    setCloudSnapshots([]);
    setSelectedCloudSnapshot(null);
    setCloudRestoreMode('restore');
    setShowCloudRestore(true);
    setCloudRestoreLoading(true);

    try {
      const installs = await fetchCloudInstalls();
      setCloudInstalls(installs);
    } catch (err) {
      setCloudRestoreError(
        err instanceof Error ? err.message : 'Failed to load cloud installations'
      );
    } finally {
      setCloudRestoreLoading(false);
    }
  }, []);

  const handleCloudRestorePrepare = useCallback(async () => {
    if (!selectedInstall) return;
    setCloudRestoreError(null);
    setCloudRestoreStep('preparing');

    try {
      const result = await prepareCloudRestore(
        selectedInstall.folder,
        cloudRestorePassword || undefined
      );

      if (result.phase === 'failed') {
        setCloudRestoreError(result.error || 'Failed to prepare cloud restore');
        setCloudRestoreStep('enter-password');
        return;
      }

      setCloudSnapshots(result.snapshots);
      setCloudRestoreStep('select-snapshot');
    } catch (err) {
      setCloudRestoreError(err instanceof Error ? err.message : 'Failed to prepare cloud restore');
      setCloudRestoreStep('enter-password');
    }
  }, [selectedInstall, cloudRestorePassword]);

  // Note: handleCloudRestoreStart and closeCloudRestore are defined after
  // startProgressPolling below to avoid block-scoping issues.

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const checkServerHealth = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(apiUrl('/api/health'), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      return response.ok;
    } catch {
      return false;
    }
  }, []);

  const startProgressPolling = useCallback(() => {
    let consecutiveErrors = 0;

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const progress = await fetchRestoreProgress();
        consecutiveErrors = 0;
        setReconnecting(false);
        setReconnectAttempts(0);

        if (progress) {
          setRestoreProgress(progress);

          // Check if restore is complete or failed
          if (
            progress.state === 'completed' ||
            progress.state === 'failed' ||
            progress.state === 'rolledBack'
          ) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setRestoreInProgress(false);

            if (progress.state === 'completed') {
              setSuccess('Backup restored successfully!');
              queryClient.invalidateQueries({ queryKey: ['backups'] });
            } else if (progress.state === 'rolledBack') {
              setError('Restore failed but was rolled back to previous state');
            } else {
              setError(progress.error || 'Restore failed');
            }

            // Reset state after showing result
            setTimeout(async () => {
              try {
                await resetRestoreState();
              } catch {
                // Ignore reset errors
              }
              setRestoreProgress(null);
            }, 3000);
          }
        }
      } catch {
        consecutiveErrors++;

        // After 3 consecutive errors, assume Keeper is restarting
        if (consecutiveErrors >= 3 && !reconnecting) {
          setReconnecting(true);
          setRestoreProgress({
            state: 'restarting',
            progress: 70,
            statusMessage: 'Keeper is restarting...',
          });
        }

        if (reconnecting) {
          setReconnectAttempts((prev) => prev + 1);

          // Check if Keeper is back
          const isHealthy = await checkServerHealth();
          if (isHealthy) {
            // Keeper is back! Force reload to get fresh state
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }

            // Brief delay then reload with cache bypass
            setTimeout(() => {
              window.location.href = window.location.pathname + '?restored=' + Date.now();
            }, 500);
          }
        }
      }
    }, 1500);

    // Stop polling after 5 minutes (safety)
    setTimeout(
      () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        if (restoreInProgress) {
          setRestoreInProgress(false);
          setReconnecting(false);
          setError('Restore timed out. Please check if SignalK is running.');
        }
      },
      5 * 60 * 1000
    );
  }, [queryClient, reconnecting, restoreInProgress, checkServerHealth]);

  const handleCloudRestoreStart = useCallback(async () => {
    if (!selectedCloudSnapshot) return;
    setCloudRestoreError(null);
    setCloudRestoreStep('restoring');

    try {
      await startCloudRestore(selectedCloudSnapshot, cloudRestoreMode);
      // Switch to the main restore progress polling (same as local restore)
      setRestoreInProgress(true);
      setReconnecting(false);
      setReconnectAttempts(0);
      startProgressPolling();
      setShowCloudRestore(false);
    } catch (err) {
      setCloudRestoreError(err instanceof Error ? err.message : 'Failed to start cloud restore');
      setCloudRestoreStep('confirm');
    }
  }, [selectedCloudSnapshot, cloudRestoreMode, startProgressPolling]);

  const closeCloudRestore = useCallback(() => {
    setShowCloudRestore(false);
    resetCloudRestoreState().catch(() => {});
  }, []);

  const handleCreateBackup = () => {
    createMutation.mutate({ description: createDescription || undefined });
  };

  const handleUploadBackup = () => {
    if (uploadFile) {
      uploadMutation.mutate({ file: uploadFile, description: uploadDescription || undefined });
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      setUploadModalOpen(true);
    }
  };

  const renderBackupList = (backups: BackupMetadata[], emptyMessage: string) => {
    if (backups.length === 0) {
      return (
        <div className="text-center py-5 text-muted">
          <FontAwesomeIcon icon={faClock} size="3x" className="mb-3" />
          <h4>No backups</h4>
          <p>{emptyMessage}</p>
        </div>
      );
    }

    return backups.map((backup) => (
      <BackupRow
        key={backup.id}
        backup={backup}
        onDelete={setDeleteConfirmId}
        onRestore={setRestoreConfirmId}
        isDeleting={deleteMutation.isPending}
        isRestoring={restoreInProgress}
      />
    ));
  };

  // Compute effective dirs (pending or server)
  const effectiveDirs = pendingDirs ?? dataDirs ?? [];
  const savedExclusionList = (dataDirs ?? [])
    .filter((d) => d.excluded)
    .map((d) => `${d.name}/`)
    .sort();
  const pendingExclusionList = effectiveDirs
    .filter((d) => d.excluded)
    .map((d) => `${d.name}/`)
    .sort();
  const exclusionsChanged =
    JSON.stringify(pendingExclusionList) !== JSON.stringify(savedExclusionList);

  return (
    <>
      {/* Alerts */}
      {error && (
        <Alert
          variant="danger"
          className="backup-alert d-flex justify-content-between align-items-center"
        >
          {error}
          <CloseButton onClick={() => setError(null)} />
        </Alert>
      )}
      {success && (
        <Alert
          variant="success"
          className="backup-alert d-flex justify-content-between align-items-center"
        >
          {success}
          <CloseButton onClick={() => setSuccess(null)} />
        </Alert>
      )}

      {/* Backup Exclusions Card */}
      <Card className="mb-3">
        <Card.Header>
          <h5 className="mb-0">
            <FontAwesomeIcon icon={faFolder} className="me-2" />
            Backup Exclusions
          </h5>
        </Card.Header>
        <Card.Body>
          {dataDirsLoading ? (
            <div className="text-center py-3">
              <Spinner size="sm" />
            </div>
          ) : effectiveDirs.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '0.875rem' }}>
              No data directories found.
            </div>
          ) : (
            <>
              <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                Excluded directories are not included in backups. Charts and plugins can be
                re-downloaded after restore.
              </div>
              <div style={{ fontSize: '0.875rem' }}>
                {effectiveDirs.map((dir) => (
                  <div key={dir.name} className="d-flex align-items-center gap-2 py-1">
                    <Form.Check
                      type="checkbox"
                      checked={dir.excluded}
                      onChange={() => {
                        const updated = effectiveDirs.map((d) =>
                          d.name === dir.name ? { ...d, excluded: !d.excluded } : d
                        );
                        setPendingDirs(updated);
                      }}
                      label=""
                    />
                    <span style={{ minWidth: '180px' }}>
                      <FontAwesomeIcon
                        icon={faFolder}
                        className="me-1 text-muted"
                        style={{ fontSize: '0.8rem' }}
                      />
                      {dir.name}
                    </span>
                    <span className="text-muted" style={{ minWidth: '80px' }}>
                      {formatSize(dir.size)}
                    </span>
                    {dir.excluded && (
                      <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                        excluded
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {pluginDataDirs && pluginDataDirs.length > 0 && (
                <>
                  <hr className="my-3" />
                  <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                    <strong>Plugin state</strong> — subdirectories of{' '}
                    <code>plugin-config-data/</code>. Live database state is auto-excluded for
                    safety; SignalK Backup&apos;s own state is excluded to prevent recursion.
                  </div>
                  {pluginDataDirsLoading ? (
                    <Spinner size="sm" />
                  ) : (
                    <div style={{ fontSize: '0.875rem' }}>
                      {pluginDataDirs.map((dir) => (
                        <div
                          key={dir.name}
                          className="d-flex align-items-center gap-2 py-1"
                          title={dir.lockReason}
                        >
                          <Form.Check
                            type="checkbox"
                            checked={dir.excluded}
                            disabled={dir.lockedExcluded}
                            readOnly={dir.lockedExcluded}
                            label=""
                          />
                          <span style={{ minWidth: '220px' }}>
                            <FontAwesomeIcon
                              icon={faFolder}
                              className="me-1 text-muted"
                              style={{ fontSize: '0.8rem' }}
                            />
                            {dir.name}
                          </span>
                          <span className="text-muted" style={{ minWidth: '80px' }}>
                            {formatSize(dir.size)}
                          </span>
                          {dir.lockedExcluded ? (
                            <span
                              className="text-muted"
                              style={{ fontSize: '0.8rem', fontStyle: 'italic' }}
                            >
                              auto-excluded
                            </span>
                          ) : (
                            dir.excluded && (
                              <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                                excluded
                              </span>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <Alert variant="info" className="mt-2 mb-0 py-2" style={{ fontSize: '0.8rem' }}>
                    Live database files (QuestDB, InfluxDB, Grafana) cannot be safely backed up by
                    filesystem snapshot — a future release will offer a safe export via each
                    plugin&apos;s API.
                  </Alert>
                </>
              )}

              {exclusionsChanged && (
                <>
                  <Alert variant="warning" className="mt-3 mb-0 py-2">
                    Changing exclusions will delete all existing backups to reclaim space. If cloud
                    sync is enabled, you&apos;ll also need to delete the backup folder on Google
                    Drive and sync again.
                  </Alert>
                  <div className="mt-2 d-flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setShowExclusionConfirm(true)}
                    >
                      Save Changes
                    </Button>
                    <Button
                      variant="outline-secondary"
                      size="sm"
                      onClick={() => setPendingDirs(null)}
                    >
                      Discard
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </Card.Body>
        <Card.Footer>
          <Button
            variant="primary"
            size="sm"
            onClick={() => createMutation.mutate({})}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Spinner size="sm" className="me-1" />
            ) : (
              <FontAwesomeIcon icon={faPlusCircle} className="me-1" />
            )}
            Create Manual Backup
          </Button>
        </Card.Footer>
      </Card>

      {/* Backup Password Card */}
      <Card className="mb-3">
        <Card.Header>
          <h5 className="mb-0">
            <FontAwesomeIcon icon={faKey} className="me-2" />
            Backup Password
          </h5>
        </Card.Header>
        <Card.Body>
          <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
            All backups are password-protected. You need this password to restore backups on a new
            device. Keep it safe.
          </div>
          {passwordStatus?.password ? (
            <div className="d-flex align-items-center gap-2">
              <code
                style={{
                  padding: '0.375rem 0.75rem',
                  background: 'var(--keeper-bg-medium)',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                }}
              >
                {showPassword ? passwordStatus.password : '\u2022'.repeat(16)}
              </code>
              <Button
                variant="link"
                size="sm"
                className="p-1"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} />
              </Button>
              <Button
                variant="link"
                size="sm"
                className="p-1"
                onClick={() => {
                  navigator.clipboard.writeText(passwordStatus.password!);
                  setSuccess('Password copied to clipboard');
                }}
                title="Copy to clipboard"
              >
                <FontAwesomeIcon icon={faCopy} />
              </Button>
            </div>
          ) : (
            <span className="text-muted" style={{ fontSize: '0.875rem' }}>
              No password set
            </span>
          )}
        </Card.Body>
      </Card>

      {/* Status Card */}
      <Card className="backup-status-card mb-3">
        <Card.Body>
          <Row className="align-items-center g-2">
            <Col>
              <div className="backup-status-info">
                {schedulerLoading ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <div className="backup-status-item">
                      {schedulerStatus?.enabled ? (
                        <FontAwesomeIcon icon={faCheckCircle} className="status-ok me-2" />
                      ) : (
                        <FontAwesomeIcon icon={faExclamationCircle} className="status-warn me-2" />
                      )}
                      <span>
                        Automatic backups {schedulerStatus?.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    {schedulerStatus?.lastBackup && (
                      <div className="backup-status-item">
                        <FontAwesomeIcon icon={faClock} className="me-2" />
                        <span>Last backup: {formatRelativeTime(schedulerStatus.lastBackup)}</span>
                      </div>
                    )}
                    {storageStats && (
                      <div className="backup-status-item">
                        <span>
                          Total:{' '}
                          {storageStats.countByType
                            ? Object.values(storageStats.countByType).reduce((a, b) => a + b, 0)
                            : 0}{' '}
                          backups ({formatSize(storageStats.totalSize)})
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </Col>
            <Col xs="auto">
              <Button
                variant="outline-secondary"
                onClick={() => refetchBackups()}
                className="backup-action-btn me-2"
              >
                <FontAwesomeIcon icon={faSync} className="me-1" />
                Refresh
              </Button>
              <Button
                variant="outline-secondary"
                onClick={() => fileInputRef.current?.click()}
                className="backup-action-btn"
              >
                <FontAwesomeIcon icon={faUpload} className="me-1" />
                Upload
              </Button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept=".zip"
                onChange={handleFileSelect}
              />
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {/* Backups List Card */}
      <Card className="mb-3">
        <Card.Header>
          <h5 className="mb-0">Backups</h5>
        </Card.Header>
        <Card.Body>
          {backupsLoading ? (
            <div className="loading-center">
              <Spinner />
            </div>
          ) : (
            <>
              <Tab.Container activeKey={activeTab} onSelect={(k) => k && setActiveTab(k)}>
                <Nav variant="tabs" className="mb-3">
                  <Nav.Item>
                    <Nav.Link eventKey="all">All ({backupsData?.backups.length || 0})</Nav.Link>
                  </Nav.Item>
                  <Nav.Item>
                    <Nav.Link eventKey="manual">
                      Manual ({backupsData?.grouped.manual.length || 0})
                    </Nav.Link>
                  </Nav.Item>
                  <Nav.Item>
                    <Nav.Link eventKey="hourly">
                      Hourly ({backupsData?.grouped.hourly.length || 0})
                    </Nav.Link>
                  </Nav.Item>
                  <Nav.Item>
                    <Nav.Link eventKey="daily">
                      Daily ({backupsData?.grouped.daily.length || 0})
                    </Nav.Link>
                  </Nav.Item>
                  <Nav.Item>
                    <Nav.Link eventKey="weekly">
                      Weekly ({backupsData?.grouped.weekly.length || 0})
                    </Nav.Link>
                  </Nav.Item>
                </Nav>

                <Tab.Content>
                  <Tab.Pane eventKey="all">
                    <div className="backup-list">
                      {renderBackupList(
                        backupsData?.backups || [],
                        'No backups yet. Create your first backup!'
                      )}
                    </div>
                  </Tab.Pane>
                  <Tab.Pane eventKey="manual">
                    <div className="backup-list">
                      {renderBackupList(
                        backupsData?.grouped.manual || [],
                        'No manual backups. Click "Create Manual Backup" to create one.'
                      )}
                    </div>
                  </Tab.Pane>
                  <Tab.Pane eventKey="hourly">
                    <div className="backup-list">
                      {renderBackupList(
                        backupsData?.grouped.hourly || [],
                        'No hourly backups yet. These are created automatically every hour.'
                      )}
                    </div>
                  </Tab.Pane>
                  <Tab.Pane eventKey="daily">
                    <div className="backup-list">
                      {renderBackupList(
                        backupsData?.grouped.daily || [],
                        'No daily backups yet. These are created at midnight.'
                      )}
                    </div>
                  </Tab.Pane>
                  <Tab.Pane eventKey="weekly">
                    <div className="backup-list">
                      {renderBackupList(
                        backupsData?.grouped.weekly || [],
                        'No weekly backups yet. These are created on Sundays.'
                      )}
                    </div>
                  </Tab.Pane>
                </Tab.Content>
              </Tab.Container>
            </>
          )}
        </Card.Body>
      </Card>

      {/* Cloud Backup Card */}
      <Card className="mt-3">
        <Card.Header>
          <h5 className="mb-0">
            <FontAwesomeIcon icon={faCloud} className="me-2" />
            Cloud Backup
          </h5>
        </Card.Header>
        <Card.Body>
          {/* Google Drive Connection */}
          <div className="cloud-section mb-3">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <strong>Google Drive</strong>
              {cloudStatus?.connected ? (
                <Badge bg="success">
                  <FontAwesomeIcon icon={faLink} className="me-1" />
                  Connected
                </Badge>
              ) : (
                <Badge bg="secondary">Not connected</Badge>
              )}
            </div>

            {cloudStatus?.connected ? (
              <div>
                {cloudStatus.email && (
                  <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                    {cloudStatus.email}
                  </div>
                )}
                <Button
                  variant="outline-secondary"
                  size="sm"
                  onClick={() => setDisconnectConfirm(true)}
                >
                  <FontAwesomeIcon icon={faLinkSlash} className="me-1" />
                  Disconnect
                </Button>
              </div>
            ) : authPolling ? (
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <Spinner size="sm" />
                  <span>Waiting for Google authorization...</span>
                </div>
                <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                  Complete the sign-in in the browser tab that just opened.
                </div>
                {showCallbackFallback && (
                  <div className="mt-3 p-2 border rounded" style={{ fontSize: '0.875rem' }}>
                    <div className="text-muted mb-2">
                      After signing in with Google, the browser will show an error page. Copy the
                      URL from the address bar of that page and paste it here:
                    </div>
                    <div className="d-flex gap-2">
                      <Form.Control
                        size="sm"
                        type="text"
                        placeholder="http://127.0.0.1:53682/..."
                        value={callbackUrl}
                        onChange={(e) => setCallbackUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleForwardCallback();
                        }}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleForwardCallback}
                        disabled={!callbackUrl.trim()}
                      >
                        Submit
                      </Button>
                    </div>
                  </div>
                )}
                <Button
                  variant="outline-secondary"
                  size="sm"
                  className="mt-2"
                  onClick={handleCancelAuth}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div>
                {!isLocalAccess && (
                  <div className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
                    For the best experience, open{' '}
                    <a href="https://127.0.0.1" target="_blank" rel="noreferrer">
                      https://127.0.0.1
                    </a>{' '}
                    on the host machine to connect Google Drive.
                  </div>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    // On desktop OS (macOS/Windows), open a regular tab so the address bar
                    // is visible — the user needs to copy the failed redirect URL.
                    // On Linux, use a popup (OAuth redirect works directly).
                    authWindowRef.current = window.open(
                      'about:blank',
                      '_blank',
                      isDesktopOS ? undefined : 'width=600,height=700'
                    );
                    connectMutation.mutate();
                  }}
                  disabled={connectMutation.isPending}
                >
                  {connectMutation.isPending ? (
                    <Spinner size="sm" className="me-1" />
                  ) : (
                    <FontAwesomeIcon icon={faLink} className="me-1" />
                  )}
                  Connect Google Drive
                </Button>
              </div>
            )}
          </div>

          {/* Sync Status & Controls (only when connected) */}
          {cloudStatus?.connected && (
            <>
              <hr style={{ borderColor: 'var(--keeper-border)' }} />

              {/* Sync Mode */}
              <div className="cloud-section mb-3">
                <label className="form-label" style={{ fontWeight: 500 }}>
                  Sync Mode
                </label>
                <Form.Select
                  size="sm"
                  value={cloudStatus.syncMode || 'manual'}
                  onChange={(e) => configMutation.mutate({ syncMode: e.target.value })}
                  style={{ maxWidth: '250px' }}
                >
                  <option value="manual">Manual only</option>
                  <option value="after_backup">After each backup</option>
                  <option value="scheduled">Scheduled</option>
                </Form.Select>

                {cloudStatus.syncMode === 'scheduled' && (
                  <Form.Select
                    size="sm"
                    className="mt-2"
                    value={cloudStatus.syncFrequency || 'daily'}
                    onChange={(e) => configMutation.mutate({ syncFrequency: e.target.value })}
                    style={{ maxWidth: '250px' }}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </Form.Select>
                )}
              </div>

              {/* Sync Status */}
              <div className="cloud-section mb-3">
                <div
                  className="d-flex align-items-center gap-3 flex-wrap"
                  style={{ fontSize: '0.875rem' }}
                >
                  {cloudStatus.syncing ? (
                    <span className="d-flex align-items-center gap-2">
                      <Spinner size="sm" className="me-1" />
                      {cloudStatus.syncProgress ? (
                        <>
                          Syncing {formatSize(cloudStatus.syncProgress.totalBytes)} to Google Drive
                          {cloudStatus.syncProgress.processedBlobs != null &&
                            cloudStatus.syncProgress.totalBlobs != null && (
                              <span className="text-muted">
                                ({cloudStatus.syncProgress.processedBlobs}/
                                {cloudStatus.syncProgress.totalBlobs} blobs)
                              </span>
                            )}
                        </>
                      ) : (
                        'Syncing...'
                      )}
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={() => cancelSyncMutation.mutate()}
                        disabled={cancelSyncMutation.isPending}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="outline-secondary"
                      size="sm"
                      onClick={() => syncMutation.mutate()}
                      disabled={syncMutation.isPending}
                    >
                      <FontAwesomeIcon icon={faCloudArrowUp} className="me-1" />
                      Sync Now
                    </Button>
                  )}

                  <span className="text-muted">
                    <FontAwesomeIcon icon={faClock} className="me-1" />
                    Last sync:{' '}
                    {cloudStatus.lastSync ? formatRelativeTime(cloudStatus.lastSync) : 'Never'}
                  </span>

                  {cloudStatus.internetAvailable === false && (
                    <span style={{ color: 'var(--keeper-warning)' }}>
                      <FontAwesomeIcon icon={faWifi} className="me-1" />
                      No internet
                    </span>
                  )}
                </div>

                {cloudStatus.lastSyncError && (
                  <Alert
                    variant="danger"
                    className="mt-2 mb-0 py-2"
                    style={{ fontSize: '0.875rem' }}
                  >
                    {cloudStatus.lastSyncError}
                  </Alert>
                )}
              </div>

              <hr style={{ borderColor: 'var(--keeper-border)' }} />

              {/* Restore from Cloud */}
              <div
                className="cloud-section mt-3 pt-3"
                style={{ borderTop: '1px solid var(--keeper-border)' }}
              >
                <div className="d-flex align-items-center justify-content-between">
                  <div>
                    <div className="d-flex align-items-center gap-2 mb-1">
                      <FontAwesomeIcon icon={faUndo} className="text-muted" />
                      <strong>Restore from Cloud</strong>
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                      Restore a backup from Google Drive to this device.
                    </div>
                  </div>
                  <Button variant="outline-light" size="sm" onClick={openCloudRestore}>
                    <FontAwesomeIcon icon={faCloudArrowDown} className="me-1" />
                    Restore from Cloud
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card.Body>
      </Card>

      {/* Cloud Restore Wizard Modal */}
      <Modal
        show={showCloudRestore}
        onHide={
          cloudRestoreStep === 'preparing' || cloudRestoreStep === 'restoring'
            ? undefined
            : closeCloudRestore
        }
        backdrop={
          cloudRestoreStep === 'preparing' || cloudRestoreStep === 'restoring' ? 'static' : true
        }
        keyboard={cloudRestoreStep !== 'preparing' && cloudRestoreStep !== 'restoring'}
        size="lg"
      >
        <Modal.Header
          closeButton={cloudRestoreStep !== 'preparing' && cloudRestoreStep !== 'restoring'}
        >
          <Modal.Title>
            <FontAwesomeIcon icon={faCloud} className="me-2" />
            Restore from Cloud
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {cloudRestoreError && (
            <Alert variant="danger" dismissible onClose={() => setCloudRestoreError(null)}>
              {cloudRestoreError}
            </Alert>
          )}

          {/* Step 1: Select Installation */}
          {cloudRestoreStep === 'select-install' && (
            <>
              <p>Select the installation to restore from:</p>
              {cloudRestoreLoading ? (
                <div className="text-center py-4">
                  <Spinner className="me-2" />
                  Loading cloud installations...
                </div>
              ) : cloudInstalls.length === 0 ? (
                <Alert variant="info">
                  No installations found on Google Drive. Make sure you have synced a backup from
                  another device.
                </Alert>
              ) : (
                <div className="d-flex flex-column gap-2">
                  {cloudInstalls.map((install) => (
                    <div
                      key={install.folder}
                      className={`p-3 rounded border ${
                        selectedInstall?.folder === install.folder
                          ? 'border-primary bg-primary bg-opacity-10'
                          : ''
                      }`}
                      style={{ cursor: 'pointer', borderColor: 'var(--keeper-border)' }}
                      onClick={() => setSelectedInstall(install)}
                    >
                      <strong>
                        {install.info?.vesselName || install.info?.installName || install.folder}
                      </strong>
                      {install.info?.hardware && (
                        <span className="text-muted ms-2">({install.info.hardware})</span>
                      )}
                      {install.info?.installId && (
                        <span className="text-muted ms-1" style={{ fontSize: '0.75rem' }}>
                          #{install.info.installId}
                        </span>
                      )}
                      {install.info?.lastUpdated && (
                        <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                          Last synced: {formatDate(install.info.lastUpdated)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Step 2: Enter Password */}
          {cloudRestoreStep === 'enter-password' && (
            <>
              <p>
                Enter the recovery password from the source device (
                {selectedInstall?.info?.vesselName || selectedInstall?.folder}).
              </p>
              <Form.Group className="mb-3">
                <Form.Label>Recovery Password</Form.Label>
                <Form.Control
                  type="password"
                  value={cloudRestorePassword}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setCloudRestorePassword(e.target.value)
                  }
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter') handleCloudRestorePrepare();
                  }}
                  placeholder="Enter recovery password"
                  autoFocus
                />
                <Form.Text className="text-muted">
                  If this is the same device and you haven&apos;t changed the password, you can
                  leave this empty.
                </Form.Text>
              </Form.Group>
            </>
          )}

          {/* Step 3: Preparing (downloading) */}
          {cloudRestoreStep === 'preparing' && (
            <div className="text-center py-4">
              <Spinner className="mb-3" />
              <p>Downloading backup from cloud...</p>
              <p className="text-muted" style={{ fontSize: '0.875rem' }}>
                This may take several minutes depending on backup size and internet speed.
              </p>
            </div>
          )}

          {/* Step 4: Select Snapshot */}
          {cloudRestoreStep === 'select-snapshot' && (
            <>
              <p>Select a backup to restore:</p>
              {cloudSnapshots.length === 0 ? (
                <Alert variant="warning">No snapshots found in this installation.</Alert>
              ) : (
                <>
                  <div
                    style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: '1px solid var(--keeper-border)',
                      borderRadius: '4px',
                    }}
                  >
                    {cloudSnapshots.slice(0, 20).map((snap) => (
                      <div
                        key={snap.id}
                        className={`p-2 d-flex align-items-center gap-2 ${
                          selectedCloudSnapshot === snap.id ? 'bg-primary bg-opacity-10' : ''
                        }`}
                        style={{
                          cursor: 'pointer',
                          borderBottom: '1px solid var(--keeper-border)',
                        }}
                        onClick={() => setSelectedCloudSnapshot(snap.id)}
                      >
                        <Form.Check
                          type="radio"
                          checked={selectedCloudSnapshot === snap.id}
                          onChange={() => setSelectedCloudSnapshot(snap.id)}
                        />
                        <FontAwesomeIcon icon={getTypeIcon(snap.type)} className="text-muted" />
                        <div className="flex-grow-1">
                          <div>
                            {formatDate(snap.createdAt)}
                            <Badge bg="secondary" className="ms-2" style={{ fontSize: '0.7rem' }}>
                              {snap.type}
                            </Badge>
                          </div>
                          {snap.description && (
                            <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                              {snap.description}
                            </div>
                          )}
                        </div>
                        <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                          {formatSize(snap.size)}
                        </span>
                        <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                          v{snap.version?.tag || '?'}
                        </span>
                      </div>
                    ))}
                  </div>

                  <Form.Group className="mt-3">
                    <Form.Label>Restore Mode</Form.Label>
                    <div className="d-flex gap-3">
                      <Form.Check
                        type="radio"
                        id="mode-restore"
                        label="Restore"
                        checked={cloudRestoreMode === 'restore'}
                        onChange={() => setCloudRestoreMode('restore')}
                      />
                      <Form.Check
                        type="radio"
                        id="mode-clone"
                        label="Clone (new device)"
                        checked={cloudRestoreMode === 'clone'}
                        onChange={() => setCloudRestoreMode('clone')}
                      />
                    </div>
                    <Form.Text className="text-muted">
                      {cloudRestoreMode === 'restore'
                        ? 'Replaces this installation with the cloud backup. Use on the same device or as a replacement.'
                        : 'Restores the backup but creates a new device identity. Use when setting up a spare device or upgrading hardware.'}
                    </Form.Text>
                  </Form.Group>
                </>
              )}
            </>
          )}

          {/* Step 5: Confirm */}
          {cloudRestoreStep === 'confirm' && (
            <>
              <Alert variant="warning">
                <strong>Warning:</strong> This will replace all SignalK configuration and data on
                this device with the selected cloud backup.
              </Alert>
              <div className="mb-3">
                <div>
                  <strong>Source:</strong>{' '}
                  {selectedInstall?.info?.vesselName || selectedInstall?.folder}
                </div>
                <div>
                  <strong>Snapshot:</strong>{' '}
                  {cloudSnapshots.find((s) => s.id === selectedCloudSnapshot)
                    ? formatDate(
                        cloudSnapshots.find((s) => s.id === selectedCloudSnapshot)!.createdAt
                      )
                    : selectedCloudSnapshot}
                </div>
                <div>
                  <strong>Mode:</strong>{' '}
                  {cloudRestoreMode === 'clone' ? 'Clone (new device identity)' : 'Restore'}
                </div>
              </div>
              <p>
                A safety backup will be created before the restore. SignalK will restart during the
                process and will be temporarily unavailable.
              </p>
            </>
          )}

          {/* Step 6: Restoring */}
          {cloudRestoreStep === 'restoring' && (
            <div className="text-center py-4">
              <Spinner className="mb-3" />
              <p>Starting restore...</p>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          {cloudRestoreStep !== 'preparing' && cloudRestoreStep !== 'restoring' && (
            <Button variant="secondary" onClick={closeCloudRestore}>
              Cancel
            </Button>
          )}

          {cloudRestoreStep === 'select-install' && (
            <Button
              variant="primary"
              disabled={!selectedInstall}
              onClick={() => setCloudRestoreStep('enter-password')}
            >
              Next
            </Button>
          )}

          {cloudRestoreStep === 'enter-password' && (
            <>
              <Button variant="secondary" onClick={() => setCloudRestoreStep('select-install')}>
                Back
              </Button>
              <Button variant="primary" onClick={handleCloudRestorePrepare}>
                Prepare Restore
              </Button>
            </>
          )}

          {cloudRestoreStep === 'select-snapshot' && (
            <>
              <Button variant="secondary" onClick={() => setCloudRestoreStep('enter-password')}>
                Back
              </Button>
              <Button
                variant="primary"
                disabled={!selectedCloudSnapshot}
                onClick={() => setCloudRestoreStep('confirm')}
              >
                Next
              </Button>
            </>
          )}

          {cloudRestoreStep === 'confirm' && (
            <>
              <Button variant="secondary" onClick={() => setCloudRestoreStep('select-snapshot')}>
                Back
              </Button>
              <Button variant="danger" onClick={handleCloudRestoreStart}>
                {cloudRestoreMode === 'clone' ? 'Clone & Restore' : 'Start Restore'}
              </Button>
            </>
          )}
        </Modal.Footer>
      </Modal>

      {/* Disconnect Confirm Modal */}
      <Modal show={disconnectConfirm} onHide={() => setDisconnectConfirm(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Disconnect Google Drive</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            This will remove the Google Drive connection. Cloud sync will stop and you will need to
            reconnect to resume cloud backups.
          </p>
          <p>Your existing cloud backups on Google Drive will not be deleted.</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDisconnectConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Disconnect
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Create Backup Modal */}
      <Modal show={createModalOpen} onHide={() => setCreateModalOpen(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Create Backup</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="create-backup-form">
            <div className="mb-3">
              <label htmlFor="backup-description" className="form-label">
                Description (optional)
              </label>
              <Form.Control
                id="backup-description"
                value={createDescription}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreateDescription(e.target.value)
                }
                placeholder="e.g., Before plugin update"
              />
            </div>
            {createMutation.isPending && (
              <ProgressBar animated now={100} aria-label="Creating backup" />
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setCreateModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateBackup}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Create Backup
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Upload Backup Modal */}
      <Modal
        show={uploadModalOpen}
        onHide={() => {
          setUploadModalOpen(false);
          setUploadFile(null);
          setUploadDescription('');
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title>Upload Backup</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="upload-backup-form">
            {uploadFile && (
              <div className="upload-file-info mb-3">
                <strong>File:</strong> {uploadFile.name} ({formatSize(uploadFile.size)})
              </div>
            )}
            <div className="mb-3">
              <label htmlFor="upload-description" className="form-label">
                Description (optional)
              </label>
              <Form.Control
                id="upload-description"
                value={uploadDescription}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setUploadDescription(e.target.value)
                }
                placeholder="e.g., Backup from old installation"
              />
            </div>
            {uploadMutation.isPending && (
              <ProgressBar animated now={100} aria-label="Uploading backup" />
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setUploadModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleUploadBackup}
            disabled={uploadMutation.isPending || !uploadFile}
          >
            {uploadMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Upload
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={deleteConfirmId !== null} onHide={() => setDeleteConfirmId(null)}>
        <Modal.Header closeButton>
          <Modal.Title>Delete Backup</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Are you sure you want to delete this backup? This action cannot be undone.
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Delete
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Restore Confirmation Modal */}
      <Modal show={restoreConfirmId !== null} onHide={() => setRestoreConfirmId(null)}>
        <Modal.Header closeButton>
          <Modal.Title>Restore Backup</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>This will restore SignalK to this backup. The process will:</p>
          <ul>
            <li>Create a safety backup of current state</li>
            <li>Extract the backup files</li>
            <li>Reinstall plugins if needed</li>
            <li>Restart SignalK</li>
          </ul>
          <p>
            <strong>SignalK will be temporarily unavailable during restore.</strong>
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setRestoreConfirmId(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => restoreConfirmId && restoreMutation.mutate(restoreConfirmId)}
            disabled={restoreMutation.isPending}
          >
            {restoreMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Restore
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Restore Progress Modal */}
      <Modal show={restoreInProgress} backdrop="static" keyboard={false}>
        <Modal.Header>
          <Modal.Title>{reconnecting ? 'Reconnecting to Keeper' : 'Restoring Backup'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="restore-progress">
            {reconnecting ? (
              <div className="reconnecting-container text-center">
                <div className="reconnecting-animation mb-3">
                  <FontAwesomeIcon icon={faPlug} size="3x" className="reconnecting-icon" />
                </div>
                <p className="reconnecting-text">Keeper is restarting...</p>
                <p className="reconnecting-subtext text-muted">
                  Waiting for connection ({reconnectAttempts} attempts)
                </p>
                <p className="reconnecting-hint text-muted small">
                  Page will reload automatically when ready
                </p>
              </div>
            ) : (
              <>
                <ProgressBar
                  now={restoreProgress?.progress || 0}
                  aria-label={getRestoreStateMessage(restoreProgress?.state || 'preparing')}
                  className="mb-2"
                />
                <p className="restore-status-message text-center mb-0">
                  {restoreProgress?.statusMessage || 'Starting restore...'}
                </p>
              </>
            )}
          </div>
        </Modal.Body>
      </Modal>

      {/* Exclusion Confirm Modal */}
      <Modal show={showExclusionConfirm} onHide={() => setShowExclusionConfirm(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Confirm Exclusion Changes</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            Changing backup exclusions will <strong>delete all existing backups</strong> and create
            a fresh one with the new settings.
          </p>
          <p>
            If cloud sync is enabled, you will also need to manually delete the backup folder on
            Google Drive and sync again.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowExclusionConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setShowExclusionConfirm(false);
              exclusionMutation.mutate(pendingExclusionList);
            }}
            disabled={exclusionMutation.isPending}
          >
            {exclusionMutation.isPending ? <Spinner size="sm" className="me-1" /> : null}
            Save Changes
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default BackupsPage;
