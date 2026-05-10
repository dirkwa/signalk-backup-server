import { apiUrl } from '../../api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Badge, Spinner, Button, Row, Col, Alert } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faClock,
  faCloud,
  faCheck,
  faTimes,
  faExclamationTriangle,
  faSync,
  faFloppyDisk,
} from '@fortawesome/free-solid-svg-icons';

// Types — minimal local definitions matching server responses
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface BackupMetadata {
  id: string;
  createdAt: string;
  type: string;
  size: number;
}

interface BackupsResponse {
  backups: BackupMetadata[];
  grouped: Record<string, BackupMetadata[]>;
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
    total: number;
    hourly: number;
    daily: number;
    weekly: number;
    startup: number;
    manual: number;
  };
}

interface CloudSyncStatus {
  connected: boolean;
  configured: boolean;
  syncing: boolean;
  lastSync: string | null;
  lastSyncError: string | null;
  internetAvailable: boolean | null;
  email?: string;
}

// API helpers
const unwrap = async <T,>(res: Response, label: string): Promise<T> => {
  const data: ApiResponse<T> = await res.json();
  if (!data.success || data.data === undefined) {
    throw new Error(data.error?.message || label);
  }
  return data.data;
};

const fetchBackups = async (): Promise<BackupsResponse> => {
  const res = await fetch(apiUrl('/api/backups'));
  return unwrap<BackupsResponse>(res, 'Failed to fetch backups');
};

const fetchScheduler = async (): Promise<SchedulerStatus> => {
  const res = await fetch(apiUrl('/api/backups/scheduler'));
  return unwrap<SchedulerStatus>(res, 'Failed to fetch scheduler status');
};

const fetchCloudStatus = async (): Promise<CloudSyncStatus> => {
  const res = await fetch(apiUrl('/api/cloud/status'));
  return unwrap<CloudSyncStatus>(res, 'Failed to fetch cloud status');
};

// Helpers
const formatDate = (dateStr: string | null | undefined): string => {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
};

const Dashboard = () => {
  const queryClient = useQueryClient();

  const {
    data: scheduler,
    isLoading: schedulerLoading,
    error: schedulerError,
  } = useQuery({
    queryKey: ['scheduler'],
    queryFn: fetchScheduler,
    refetchInterval: 15000,
  });

  const {
    data: backups,
    isLoading: backupsLoading,
    error: backupsError,
  } = useQuery({
    queryKey: ['backups'],
    queryFn: fetchBackups,
    refetchInterval: 30000,
  });

  const {
    data: cloud,
    isLoading: cloudLoading,
    error: cloudError,
  } = useQuery({
    queryKey: ['cloudStatus'],
    queryFn: fetchCloudStatus,
    refetchInterval: 15000,
  });

  const refreshBackup = () => {
    queryClient.invalidateQueries({ queryKey: ['scheduler'] });
    queryClient.invalidateQueries({ queryKey: ['backups'] });
  };

  const refreshCloud = () => {
    queryClient.invalidateQueries({ queryKey: ['cloudStatus'] });
  };

  const snapshotCount = backups?.backups.length ?? scheduler?.backupCounts.total ?? 0;
  const lastBackup = scheduler?.lastBackup ?? null;

  return (
    <div className="dashboard">
      <Row>
        {/* Backup Status Card */}
        <Col xs={12} md={6}>
          <Card className="mb-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>
                <FontAwesomeIcon icon={faFloppyDisk} className="me-2" />
                <strong>Backup Status</strong>
              </span>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={refreshBackup}
                disabled={schedulerLoading || backupsLoading}
                aria-label="Refresh backup status"
              >
                <FontAwesomeIcon icon={faSync} />
              </Button>
            </Card.Header>
            <Card.Body>
              {schedulerLoading || backupsLoading ? (
                <div className="text-center py-3">
                  <Spinner size="sm" />
                </div>
              ) : schedulerError || backupsError ? (
                <Alert variant="danger" className="mb-0">
                  <FontAwesomeIcon icon={faExclamationTriangle} className="me-2" />
                  {(schedulerError as Error)?.message ||
                    (backupsError as Error)?.message ||
                    'Failed to load backup status'}
                </Alert>
              ) : (
                <>
                  <div className="mb-2">
                    <Badge
                      bg={scheduler?.enabled ? 'success' : 'secondary'}
                      className="d-inline-flex align-items-center gap-1"
                    >
                      <FontAwesomeIcon icon={scheduler?.enabled ? faCheck : faTimes} />
                      {scheduler?.enabled ? 'Scheduler running' : 'Scheduler stopped'}
                    </Badge>
                  </div>
                  <Row className="g-2">
                    <Col xs={6}>
                      <small className="text-muted d-block">Last backup</small>
                      <div>
                        <FontAwesomeIcon icon={faClock} className="me-1 text-muted" />
                        {formatDate(lastBackup)}
                      </div>
                    </Col>
                    <Col xs={6}>
                      <small className="text-muted d-block">Snapshots</small>
                      <div>{snapshotCount}</div>
                    </Col>
                  </Row>
                  {scheduler && (
                    <Row className="g-2 mt-2">
                      <Col xs={4}>
                        <small className="text-muted d-block">Hourly</small>
                        <div>{scheduler.backupCounts.hourly}</div>
                      </Col>
                      <Col xs={4}>
                        <small className="text-muted d-block">Daily</small>
                        <div>{scheduler.backupCounts.daily}</div>
                      </Col>
                      <Col xs={4}>
                        <small className="text-muted d-block">Weekly</small>
                        <div>{scheduler.backupCounts.weekly}</div>
                      </Col>
                    </Row>
                  )}
                </>
              )}
            </Card.Body>
          </Card>
        </Col>

        {/* Cloud Sync Status Card */}
        <Col xs={12} md={6}>
          <Card className="mb-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>
                <FontAwesomeIcon icon={faCloud} className="me-2" />
                <strong>Cloud Sync</strong>
              </span>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={refreshCloud}
                disabled={cloudLoading}
                aria-label="Refresh cloud sync status"
              >
                <FontAwesomeIcon icon={faSync} />
              </Button>
            </Card.Header>
            <Card.Body>
              {cloudLoading ? (
                <div className="text-center py-3">
                  <Spinner size="sm" />
                </div>
              ) : cloudError ? (
                <Alert variant="danger" className="mb-0">
                  <FontAwesomeIcon icon={faExclamationTriangle} className="me-2" />
                  {(cloudError as Error).message}
                </Alert>
              ) : (
                <>
                  <div className="mb-2">
                    <Badge
                      bg={cloud?.connected ? 'success' : 'secondary'}
                      className="d-inline-flex align-items-center gap-1"
                    >
                      <FontAwesomeIcon icon={cloud?.connected ? faCheck : faTimes} />
                      {cloud?.connected ? 'Drive connected' : 'Not connected'}
                    </Badge>
                    {cloud?.syncing && (
                      <Badge bg="info" className="ms-2 d-inline-flex align-items-center gap-1">
                        <Spinner size="sm" /> Syncing
                      </Badge>
                    )}
                  </div>
                  {cloud?.email && (
                    <Row className="g-2">
                      <Col xs={12}>
                        <small className="text-muted d-block">Account</small>
                        <div className="text-truncate">{cloud.email}</div>
                      </Col>
                    </Row>
                  )}
                  <Row className="g-2 mt-2">
                    <Col xs={12}>
                      <small className="text-muted d-block">Last sync</small>
                      <div>
                        <FontAwesomeIcon icon={faClock} className="me-1 text-muted" />
                        {formatDate(cloud?.lastSync)}
                      </div>
                    </Col>
                  </Row>
                  {cloud?.lastSyncError && (
                    <Alert variant="warning" className="mt-2 mb-0 py-2">
                      <FontAwesomeIcon icon={faExclamationTriangle} className="me-1" />
                      <small>{cloud.lastSyncError}</small>
                    </Alert>
                  )}
                </>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
