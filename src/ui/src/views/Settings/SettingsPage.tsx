import { apiUrl } from '../../api';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CloseButton, Col, Form, Modal, Row, Spinner } from 'react-bootstrap';

// Types
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface BackupSchedulerStatus {
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

interface PasswordStatus {
  hasCustomPassword: boolean;
  password?: string;
}

interface ExclusionsResponse {
  exclusions: string[];
}

// API helpers
const unwrap = async <T,>(res: Response, label: string): Promise<T> => {
  const data: ApiResponse<T> = await res.json();
  if (!data.success || data.data === undefined) {
    throw new Error(data.error?.message || label);
  }
  return data.data;
};

// API functions
const fetchBackupSchedulerStatus = async (): Promise<BackupSchedulerStatus> => {
  const res = await fetch(apiUrl('/api/backups/scheduler'));
  return unwrap<BackupSchedulerStatus>(res, 'Failed to fetch scheduler status');
};

const startBackupScheduler = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/backups/scheduler/start'), { method: 'POST' });
  const data: ApiResponse<unknown> = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to start scheduler');
};

const stopBackupScheduler = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/backups/scheduler/stop'), { method: 'POST' });
  const data: ApiResponse<unknown> = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to stop scheduler');
};

const fetchPasswordStatus = async (): Promise<PasswordStatus> => {
  const res = await fetch(apiUrl('/api/backups/password'));
  return unwrap<PasswordStatus>(res, 'Failed to fetch password status');
};

const changePassword = async (params: {
  password: string;
  confirmPassword: string;
}): Promise<void> => {
  const res = await fetch(apiUrl('/api/backups/password'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data: ApiResponse<unknown> = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to change password');
};

const resetPassword = async (): Promise<void> => {
  const res = await fetch(apiUrl('/api/backups/password'), { method: 'DELETE' });
  const data: ApiResponse<unknown> = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'Failed to reset password');
};

const fetchExclusions = async (): Promise<string[]> => {
  const res = await fetch(apiUrl('/api/backups/exclusions'));
  const data = await unwrap<ExclusionsResponse>(res, 'Failed to fetch exclusions');
  return data.exclusions;
};

const updateExclusions = async (exclusions: string[]): Promise<string[]> => {
  const res = await fetch(apiUrl('/api/backups/exclusions'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exclusions }),
  });
  const data = await unwrap<ExclusionsResponse>(res, 'Failed to update exclusions');
  return data.exclusions;
};

// Helpers
const formatDate = (dateStr: string): string => {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
};

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Password modal state
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetModalOpen, setResetModalOpen] = useState(false);

  // Exclusions edit state
  const [exclusionsText, setExclusionsText] = useState<string>('');

  // Queries
  const { data: backupScheduler, isLoading: backupSchedulerLoading } = useQuery({
    queryKey: ['backupScheduler'],
    queryFn: fetchBackupSchedulerStatus,
    staleTime: 30000,
  });

  const { data: passwordStatus, isLoading: passwordLoading } = useQuery({
    queryKey: ['passwordStatus'],
    queryFn: fetchPasswordStatus,
    staleTime: 30000,
  });

  const { data: exclusions, isLoading: exclusionsLoading } = useQuery({
    queryKey: ['backupExclusions'],
    queryFn: fetchExclusions,
    staleTime: 30000,
  });

  // Sync server state into the editor whenever fresh data arrives
  useEffect(() => {
    if (exclusions) {
      setExclusionsText(exclusions.join('\n'));
    }
  }, [exclusions]);

  // Mutations
  const startSchedulerMutation = useMutation({
    mutationFn: startBackupScheduler,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backupScheduler'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const stopSchedulerMutation = useMutation({
    mutationFn: stopBackupScheduler,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backupScheduler'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const changePasswordMutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['passwordStatus'] });
      setPasswordModalOpen(false);
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (err: Error) => setError(err.message),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: resetPassword,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['passwordStatus'] });
      setResetModalOpen(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const exclusionsMutation = useMutation({
    mutationFn: updateExclusions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backupExclusions'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleBackupSchedulerToggle = (checked: boolean) => {
    if (checked) {
      startSchedulerMutation.mutate();
    } else {
      stopSchedulerMutation.mutate();
    }
  };

  const handleChangePassword = () => {
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    changePasswordMutation.mutate({
      password: newPassword,
      confirmPassword: confirmPassword,
    });
  };

  const handleSaveExclusions = () => {
    const list = exclusionsText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    exclusionsMutation.mutate(list);
  };

  const passwordsMatch = newPassword.length >= 8 && newPassword === confirmPassword;

  const exclusionsDirty =
    exclusions !== undefined &&
    exclusionsText.trim() !==
      exclusions
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join('\n');

  return (
    <Card>
      <Card.Header>
        <h5 className="mb-0">Settings</h5>
      </Card.Header>
      <Card.Body>
        {error && (
          <Alert
            variant="danger"
            className="settings-alert d-flex justify-content-between align-items-center"
          >
            {error}
            <CloseButton onClick={() => setError(null)} />
          </Alert>
        )}

        {/* Automatic Backups */}
        <div className="settings-section">
          <h6 className="settings-section-title mb-3">Automatic Backups</h6>

          {backupSchedulerLoading ? (
            <div className="loading-center">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="settings-form">
              <Row className="settings-row align-items-center mb-3">
                <Col>
                  <div className="settings-label">Enable Automatic Backups</div>
                  <div className="settings-description text-muted small">
                    Automatically create hourly, daily, and weekly backups of your SignalK
                    configuration.
                  </div>
                </Col>
                <Col xs="auto">
                  <Form.Check
                    type="switch"
                    id="backup-scheduler"
                    label="Enable automatic backups"
                    checked={backupScheduler?.enabled || false}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      handleBackupSchedulerToggle(e.target.checked)
                    }
                    disabled={startSchedulerMutation.isPending || stopSchedulerMutation.isPending}
                    className="mb-0"
                  />
                </Col>
              </Row>

              {backupScheduler?.enabled && (
                <div className="settings-info backup-retention-info bg-light p-3 rounded">
                  <strong>Retention Policy:</strong>
                  <ul className="mb-0 mt-2">
                    <li>Hourly backups: keep last 24</li>
                    <li>Daily backups: keep last 7</li>
                    <li>Weekly backups: keep last 4</li>
                    <li>Startup backups: keep last 3</li>
                  </ul>
                  {backupScheduler.lastBackup && (
                    <div style={{ marginTop: '8px' }}>
                      Last backup: {formatDate(backupScheduler.lastBackup)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Backup Password Section */}
        <div className="settings-section mt-4">
          <h6 className="settings-section-title mb-3">Backup Password</h6>

          {passwordLoading ? (
            <div className="loading-center">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="settings-form">
              <Row className="settings-row align-items-center mb-3">
                <Col>
                  <div className="settings-label">Backup Password</div>
                  <div className="settings-description text-muted small">
                    All backups are password-protected. A default password is used unless you set a
                    custom one.
                  </div>
                </Col>
                <Col xs="auto" className="d-flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setPasswordModalOpen(true)}
                    disabled={changePasswordMutation.isPending}
                  >
                    Change Password
                  </Button>
                  {passwordStatus?.hasCustomPassword && (
                    <Button
                      variant="warning"
                      size="sm"
                      onClick={() => setResetModalOpen(true)}
                      disabled={resetPasswordMutation.isPending}
                    >
                      Reset to Default
                    </Button>
                  )}
                </Col>
              </Row>

              <Alert variant="info" className="mb-0">
                {passwordStatus?.hasCustomPassword
                  ? 'Using a custom backup password.'
                  : 'Using default backup password.'}
              </Alert>
            </div>
          )}
        </div>

        {/* Backup Excludes Section */}
        <div className="settings-section mt-4">
          <h6 className="settings-section-title mb-3">Backup Excludes</h6>

          {exclusionsLoading ? (
            <div className="loading-center">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="settings-form">
              <div className="settings-description text-muted small mb-2">
                Paths under the SignalK data directory to skip when creating backups. One pattern
                per line (for example, <code>node_modules</code>, <code>charts*</code>).
              </div>
              <Form.Group className="mb-2">
                <Form.Control
                  as="textarea"
                  rows={6}
                  value={exclusionsText}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setExclusionsText(e.target.value)
                  }
                  spellCheck={false}
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Group>
              <div className="d-flex gap-2 align-items-center">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveExclusions}
                  disabled={!exclusionsDirty || exclusionsMutation.isPending}
                >
                  {exclusionsMutation.isPending ? <Spinner size="sm" /> : 'Save Excludes'}
                </Button>
                {exclusions && exclusionsDirty && (
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    onClick={() => setExclusionsText(exclusions.join('\n'))}
                  >
                    Reset
                  </Button>
                )}
                {exclusionsMutation.isSuccess && !exclusionsDirty && (
                  <small className="text-success">Saved</small>
                )}
              </div>
            </div>
          )}
        </div>
      </Card.Body>

      {/* Change Password Modal */}
      <Modal show={passwordModalOpen} onHide={() => setPasswordModalOpen(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Change Backup Password</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            <strong>Warning:</strong> Changing the password will re-create the backup repository.
            Existing backups will be lost.
          </Alert>
          <Form.Group>
            <Form.Label htmlFor="new-password">New Password</Form.Label>
            <Form.Control
              type="password"
              id="new-password"
              value={newPassword}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              minLength={8}
            />
          </Form.Group>
          <Form.Group>
            <Form.Label htmlFor="confirm-password">Confirm Password</Form.Label>
            <Form.Control
              type="password"
              id="confirm-password"
              value={confirmPassword}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setConfirmPassword(e.target.value)
              }
              placeholder="Re-enter password"
              isValid={confirmPassword.length > 0 && passwordsMatch}
              isInvalid={confirmPassword.length > 0 && !passwordsMatch}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setPasswordModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleChangePassword}
            disabled={!passwordsMatch || changePasswordMutation.isPending}
          >
            {changePasswordMutation.isPending ? <Spinner size="sm" /> : 'Change Password'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Reset Password Modal */}
      <Modal show={resetModalOpen} onHide={() => setResetModalOpen(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Reset to Default Password</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            This will reset to the default password and re-create the backup repository. Existing
            backups will be lost.
          </Alert>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setResetModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="warning"
            onClick={() => resetPasswordMutation.mutate()}
            disabled={resetPasswordMutation.isPending}
          >
            {resetPasswordMutation.isPending ? <Spinner size="sm" /> : 'Reset to Default'}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
};

export default SettingsPage;
