import { useState, useEffect, useRef, useCallback, type CSSProperties, type ReactNode } from 'react';
import axios from 'axios';
import {
  Card,
  CardBody,
  CardTitle,
  CardHeader,
  FormGroup,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  InputGroup,
  InputGroupItem,
  TextInput,
  Button,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  CodeBlock,
  CodeBlockCode,
  Spinner,
  Title,
  Flex,
  FlexItem,
  Popover,
  EmptyState,
  EmptyStateBody,
  Alert,
  Timestamp,
  Tooltip,
  Dropdown,
  DropdownItem,
  DropdownList,
  Divider,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarGroup,
  ExpandableSection,
  ExpandableSectionToggle,
  Switch,
  NumberInput,
  TreeView,
  type TreeViewDataItem,
} from '@patternfly/react-core';
import {
  SyncAltIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
  ListIcon,
  CopyIcon,
  InfoCircleIcon,
  OutlinedClockIcon,
  EllipsisVIcon,
  AngleUpIcon,
  PlusCircleIcon,
  CheckIcon,
  TimesIcon,
  TrashAltIcon,
  SearchIcon,
  DownloadIcon,
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
} from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { useAlerts } from '../AlertContext';

interface ConfigFile {
  name: string;
  size: string;
}

interface Operation {
  id: string;
  name: string;
  configFile: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  mirrorDestination?: string;
  /** Filenames copied into data/artifacts/{id}/ at success (e.g. mirror_000001.tar). */
  artifactFiles?: string[];
  errorMessage?: string;
}

interface OptionalFlags {
  removeSignatures: boolean;
  imageTimeoutEnabled: boolean;
  imageTimeoutMinutes: string;
  imageTimeoutSeconds: string;
  retryDelayEnabled: boolean;
  retryDelaySeconds: string;
  retryTimesEnabled: boolean;
  retryTimesValue: string;
}

interface OptionalFlagsPayload {
  removeSignatures?: boolean;
  imageTimeout?: string;
  retryDelay?: string;
  retryTimes?: number;
}

interface MirrorArtifact {
  filename: string;
  sizeBytes: number;
  lastModified: string;
  downloadUrl: string;
}

interface ArtifactListing {
  artifacts: MirrorArtifact[];
  error?: string;
}

interface WorkingDirItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  hasChildren: boolean;
}

interface WorkingDirState {
  /** Items fetched per directory path ('root' key = top level). */
  fetched: Record<string, WorkingDirItem[]>;
  /** Directory paths currently being fetched. */
  loadingPaths: Set<string>;
  workingDirPath?: string;
  hostWorkingDirPath?: string;
  /** Top-level error (e.g. working-dir missing). */
  error?: string;
}

const DEFAULT_OPTIONAL_FLAGS: OptionalFlags = {
  removeSignatures: false,
  imageTimeoutEnabled: false,
  imageTimeoutMinutes: '10',
  imageTimeoutSeconds: '0',
  retryDelayEnabled: false,
  retryDelaySeconds: '0',
  retryTimesEnabled: false,
  retryTimesValue: '5',
};

const infoButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 'auto',
  height: '1.25rem',
  lineHeight: 1,
  position: 'relative',
  top: '1px',
  color: 'var(--pf-t--global--text--color--regular, #151515)',
};

const FormGroupInfoLabel = ({
  text,
  ariaLabel,
  bodyContent,
}: {
  text: string;
  ariaLabel: string;
  bodyContent: ReactNode;
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--pf-t--global--spacer--xs)',
    }}
  >
    <span>{text}</span>
    <Popover
      bodyContent={bodyContent}
      // Keep the popover inside the card: triggers sit on the left edge,
      // so prefer opening to the right / bottom-start instead of centered top.
      position="right"
      flipBehavior={['right', 'right-start', 'bottom-start', 'top-start', 'bottom', 'top']}
    >
      <Button
        variant="plain"
        aria-label={ariaLabel}
        hasNoPadding
        type="button"
        style={infoButtonStyle}
      >
        <InfoCircleIcon style={{ fontSize: '0.875rem' }} />
      </Button>
    </Popover>
  </span>
);

const sanitizeDigitsInput = (value: string): string => value.replace(/\D+/g, '');

const parseNonNegativeInt = (value: string): number | null => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return 0;
  }
  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }
  return Number.parseInt(trimmedValue, 10);
};

const formatGoDuration = (minutes: string, seconds: string): string | null => {
  const mins = parseNonNegativeInt(minutes);
  const secs = parseNonNegativeInt(seconds);
  if (mins === null || secs === null) {
    return null;
  }
  if (mins > 0 && secs > 0) {
    return `${mins}m${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return `${secs}s`;
};

const getDurationTotalSeconds = (minutes: string, seconds: string): number | null => {
  const mins = parseNonNegativeInt(minutes);
  const secs = parseNonNegativeInt(seconds);
  if (mins === null || secs === null) {
    return null;
  }
  return mins * 60 + secs;
};

const getDurationValidationMessage = (
  minutes: string,
  seconds: string,
  label: string,
  requirePositive: boolean,
): string => {
  const totalSeconds = getDurationTotalSeconds(minutes, seconds);
  if (totalSeconds === null) {
    return `${label} must contain digits only`;
  }
  if (requirePositive && totalSeconds <= 0) {
    return `${label} must be greater than 0`;
  }
  return '';
};

const getNonNegativeIntegerValidationMessage = (value: string, label: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return `${label} is required when enabled`;
  }
  if (!/^\d+$/.test(trimmedValue)) {
    return `${label} must contain digits only`;
  }
  return '';
};

const buildOptionalFlagsPayload = (flags: OptionalFlags): OptionalFlagsPayload | null => {
  const payload: OptionalFlagsPayload = {};

  if (flags.removeSignatures) {
    payload.removeSignatures = true;
  }

  if (flags.imageTimeoutEnabled) {
    const message = getDurationValidationMessage(
      flags.imageTimeoutMinutes,
      flags.imageTimeoutSeconds,
      'Image timeout',
      true,
    );
    if (message) {
      return null;
    }
    const duration = formatGoDuration(flags.imageTimeoutMinutes, flags.imageTimeoutSeconds);
    if (!duration) {
      return null;
    }
    payload.imageTimeout = duration;
  }

  if (flags.retryDelayEnabled) {
    const message = getNonNegativeIntegerValidationMessage(flags.retryDelaySeconds, 'Retry delay');
    if (message) {
      return null;
    }
    payload.retryDelay = `${Number.parseInt(flags.retryDelaySeconds, 10)}s`;
  }

  if (flags.retryTimesEnabled) {
    const message = getNonNegativeIntegerValidationMessage(flags.retryTimesValue, 'Retry times');
    if (message) {
      return null;
    }
    payload.retryTimes = Number.parseInt(flags.retryTimesValue, 10);
  }

  return payload;
};

const getOptionalFlagsValidationError = (flags: OptionalFlags): string => {
  if (flags.imageTimeoutEnabled) {
    const message = getDurationValidationMessage(
      flags.imageTimeoutMinutes,
      flags.imageTimeoutSeconds,
      'Image timeout',
      true,
    );
    if (message) {
      return message;
    }
  }
  if (flags.retryDelayEnabled) {
    const message = getNonNegativeIntegerValidationMessage(flags.retryDelaySeconds, 'Retry delay');
    if (message) {
      return message;
    }
  }
  if (flags.retryTimesEnabled) {
    const message = getNonNegativeIntegerValidationMessage(flags.retryTimesValue, 'Retry times');
    if (message) {
      return message;
    }
  }
  return '';
};

const adjustDigitField = (value: string, delta: number, min: number): string => {
  const current = parseNonNegativeInt(value) ?? 0;
  return String(Math.max(min, current + delta));
};

const MirrorOperations: React.FC = () => {
  const { addSuccessAlert, addDangerAlert, addWarningAlert } = useAlerts();

  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedConfig, setSelectedConfig] = useState('');
  const [configSelectOpen, setConfigSelectOpen] = useState(false);
  const [availableConfigs, setAvailableConfigs] = useState<ConfigFile[]>([]);
  const [runningOperation, setRunningOperation] = useState<Operation | null>(null);
  const [logs, setLogs] = useState('');
  const [logStream, setLogStream] = useState<EventSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFilename, setDeleteFilename] = useState('');
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null);
  const [mirrorDestinationSubdir, setMirrorDestinationSubdir] = useState('');
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [folderSelectOpen, setFolderSelectOpen] = useState(false);
  const [folderCreateMode, setFolderCreateMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showStopModal, setShowStopModal] = useState(false);
  const [stopOperationId, setStopOperationId] = useState<string | null>(null);
  const [kebabOpen, setKebabOpen] = useState<Record<string, boolean>>({});
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactListing | undefined>>({});
  const [artifactsLoading, setArtifactsLoading] = useState<Record<string, boolean>>({});
  const [workingDirs, setWorkingDirs] = useState<Record<string, WorkingDirState>>({});
  const [showWorkingDir, setShowWorkingDir] = useState(false);
  const [workingDirOpId, setWorkingDirOpId] = useState<string | null>(null);
  const [hostDataDir, setHostDataDir] = useState('');
  const [now, setNow] = useState(Date.now());

  const [opsFilter, setOpsFilter] = useState('all');
  const [opsFilterOpen, setOpsFilterOpen] = useState(false);
  const [checkedOpIds, setCheckedOpIds] = useState<Set<string>>(new Set());
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<'selected' | 'all' | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [advancedOptionsExpanded, setAdvancedOptionsExpanded] = useState(false);
  const [optionalFlags, setOptionalFlags] = useState<OptionalFlags>(DEFAULT_OPTIONAL_FLAGS);

  const operationsRef = useRef<Operation[]>([]);
  const notifiedOperationsRef = useRef(new Set<string>());
  const logStreamOperationIdRef = useRef<string | null>(null);
  const lastRunningOperationIdRef = useRef<string | null>(null);

  const stopLogStream = useCallback(() => {
    if (logStream) {
      logStream.close();
      setLogStream(null);
    }
    logStreamOperationIdRef.current = null;
  }, [logStream]);

  const fetchLogs = useCallback(async (operationId: string) => {
    try {
      const response = await axios.get(`/api/operations/${operationId}/logs`);
      setLogs(response.data.logs || 'No logs available for this operation');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      console.error('Error fetching logs:', error);
      setLogs(`Error loading logs: ${err.response?.data?.message || err.message}`);
    }
  }, []);

  const fetchArtifacts = useCallback(async (operationId: string) => {
    setArtifactsLoading(prev => ({ ...prev, [operationId]: true }));
    try {
      const response = await axios.get<ArtifactListing>(
        `/api/operations/${operationId}/artifacts`,
        { timeout: 15_000 },
      );
      const data = response.data;
      // Guard against SPA/HTML fallback responses that are 200 but not JSON listings.
      if (!data || !Array.isArray(data.artifacts)) {
        setArtifacts(prev => ({
          ...prev,
          [operationId]: {
            artifacts: [],
            error: 'Invalid archive listing response',
          },
        }));
        return;
      }
      setArtifacts(prev => ({ ...prev, [operationId]: data }));
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } }; message?: string; code?: string };
      console.error('Error fetching artifacts:', error);
      setArtifacts(prev => ({
        ...prev,
        [operationId]: {
          artifacts: [],
          error: err.response?.data?.error || err.message || 'Failed to load archives',
        },
      }));
    } finally {
      setArtifactsLoading(prev => ({ ...prev, [operationId]: false }));
    }
  }, []);

  const handleOperationCompleted = useCallback((op: Operation) => {
    if (!op?.id) return;

    setTimeout(() => fetchLogs(op.id), 500);

    const isTerminalStatus = op.status === 'success' || op.status === 'failed' || op.status === 'stopped';
    if (!isTerminalStatus) return;

    if (!notifiedOperationsRef.current.has(op.id)) {
      notifiedOperationsRef.current.add(op.id);

      if (op.status === 'success') {
        addSuccessAlert('Mirror Operation Completed!');
        // Warm the archive listing so the kebab does not start from a blank state.
        if (op.mirrorDestination) {
          void fetchArtifacts(op.id);
        }
      } else if (op.status === 'failed') {
        addDangerAlert('Mirror Operation Failed');
      } else if (op.status === 'stopped') {
        addWarningAlert('Mirror Operation Stopped');
      }
    }
  }, [addSuccessAlert, addDangerAlert, addWarningAlert, fetchLogs, fetchArtifacts]);

  const startLogStream = useCallback((operationId: string) => {
    if (logStream) {
      logStream.close();
    }

    const eventSource = new EventSource(`/api/operations/${operationId}/logstream`);
    setLogStream(eventSource);
    logStreamOperationIdRef.current = operationId;

    eventSource.onmessage = (event) => {
      setLogs(prevLogs => prevLogs + event.data);
    };

    eventSource.addEventListener('done', (event) => {
      let payload: { status?: string } | null = null;
      try {
        payload = JSON.parse((event as MessageEvent).data);
      } catch { /* ignore parse errors */ }

      const status = payload?.status || 'unknown';
      const completedOp = operationsRef.current.find(op => op.id === operationId) || {
        id: operationId,
        status: status as Operation['status'],
        name: '',
        configFile: '',
        startedAt: '',
      };
      handleOperationCompleted(completedOp);
      lastRunningOperationIdRef.current = null;
      stopLogStream();
    });

    eventSource.onerror = () => {
      eventSource.close();
      setLogStream(null);
      logStreamOperationIdRef.current = null;
    };

    return eventSource;
  }, [logStream, handleOperationCompleted, stopLogStream]);

  const fetchConfigurations = useCallback(async () => {
    try {
      const response = await axios.get('/api/config/list');
      setAvailableConfigs(response.data);
    } catch (error) {
      console.error('Error fetching configurations:', error);
    }
  }, []);

  const fetchFolders = useCallback(async () => {
    try {
      const response = await axios.get<{ folders: string[] }>('/api/mirror-folders');
      setAvailableFolders(response.data.folders ?? []);
    } catch (error) {
      console.error('Error fetching mirror folders:', error);
      setAvailableFolders([]);
    }
  }, []);

  const confirmCreateFolder = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await axios.post('/api/mirror-folders', { name: trimmed });
      await fetchFolders();
      setMirrorDestinationSubdir(trimmed);
      addSuccessAlert(`Folder "${trimmed}" created`);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      addDangerAlert(`Failed to create folder: ${err.response?.data?.error || err.message}`);
    }
    setFolderCreateMode(false);
    setNewFolderName('');
    setFolderSelectOpen(false);
  }, [fetchFolders, addSuccessAlert, addDangerAlert]);

  /**
   * Fetch one level of the working-dir tree for a given operation and subpath.
   * 'root' is the sentinel key for the top-level directory.
   * Called both for the initial load and on each directory expansion.
   */
  const fetchWorkingDirPath = useCallback(async (operationId: string, subpath: string) => {
    const key = subpath || 'root';

    setWorkingDirs(prev => {
      const current = prev[operationId] ?? { fetched: {}, loadingPaths: new Set() };
      const newLoadingPaths = new Set(current.loadingPaths);
      newLoadingPaths.add(key);
      return { ...prev, [operationId]: { ...current, loadingPaths: newLoadingPaths } };
    });

    try {
      const url = subpath
        ? `/api/operations/${operationId}/working-dir?path=${encodeURIComponent(subpath)}`
        : `/api/operations/${operationId}/working-dir`;

      const response = await axios.get<{
        items: WorkingDirItem[];
        workingDirPath: string;
        hostWorkingDirPath: string;
        currentPath: string;
      }>(url);

      setWorkingDirs(prev => {
        const current = prev[operationId] ?? { fetched: {}, loadingPaths: new Set() };
        const newLoadingPaths = new Set(current.loadingPaths);
        newLoadingPaths.delete(key);
        return {
          ...prev,
          [operationId]: {
            ...current,
            fetched: { ...current.fetched, [key]: response.data.items },
            loadingPaths: newLoadingPaths,
            workingDirPath: response.data.workingDirPath,
            hostWorkingDirPath: response.data.hostWorkingDirPath,
          },
        };
      });
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      const msg = err.response?.data?.error || err.message || 'Failed to load working-dir';
      console.error('Error fetching working-dir:', error);
      setWorkingDirs(prev => {
        const current = prev[operationId] ?? { fetched: {}, loadingPaths: new Set() };
        const newLoadingPaths = new Set(current.loadingPaths);
        newLoadingPaths.delete(key);
        return { ...prev, [operationId]: { ...current, loadingPaths: newLoadingPaths, error: msg } };
      });
    }
  }, []);

  const fetchOperations = useCallback(async () => {
    try {
      const response = await axios.get('/api/operations');
      const previousOps = operationsRef.current;
      setOperations(response.data);

      response.data.forEach((op: Operation) => {
        const prevOp = previousOps.find(p => p.id === op.id);
        const justCompleted = prevOp && prevOp.status === 'running' &&
          (op.status === 'success' || op.status === 'failed' || op.status === 'stopped');

        if (justCompleted) {
          handleOperationCompleted(op);
        }
      });

      const running = response.data.find((op: Operation) => op.status === 'running');
      if (running) {
        lastRunningOperationIdRef.current = running.id;
      }

      if (!running && lastRunningOperationIdRef.current) {
        const lastOpId = lastRunningOperationIdRef.current;
        const completedOp = response.data.find((op: Operation) => op.id === lastOpId);
        if (completedOp && (completedOp.status === 'success' || completedOp.status === 'failed' || completedOp.status === 'stopped')) {
          handleOperationCompleted(completedOp);
          if (logStreamOperationIdRef.current === completedOp.id) {
            stopLogStream();
          }
          lastRunningOperationIdRef.current = null;
        }
      }
      setRunningOperation(running || null);

      if (running) {
        fetchLogs(running.id);
      }
    } catch (error) {
      console.error('Error fetching operations:', error);
    }
  }, [handleOperationCompleted, stopLogStream, fetchLogs]);

  useEffect(() => {
    fetchOperations();
    fetchConfigurations();
    void fetchFolders();
    axios.get('/api/system/info').then(res => setHostDataDir(res.data.hostDataDir || '')).catch(() => {});
    const interval = setInterval(fetchOperations, 5000);
    return () => clearInterval(interval);
  }, [fetchOperations, fetchConfigurations, fetchFolders]);

  useEffect(() => {
    operationsRef.current = operations;
  }, [operations]);

  // Fetch archive listings when a kebab opens. Do not rely only on Dropdown
  // onOpenChange — PatternFly may open via MenuToggle onClick without that
  // callback, which previously left the menu stuck on "Loading archives…".
  const prevKebabOpenRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const prev = prevKebabOpenRef.current;
    for (const [id, open] of Object.entries(kebabOpen)) {
      if (!open || prev[id]) continue;
      const op = operations.find((o) => o.id === id);
      if (!op || op.status !== 'success' || !op.mirrorDestination) continue;
      if (artifactsLoading[id]) continue;
      const listing = artifacts[id];
      if (!listing || listing.error) {
        void fetchArtifacts(id);
      }
    }
    prevKebabOpenRef.current = { ...kebabOpen };
  }, [kebabOpen, operations, artifacts, artifactsLoading, fetchArtifacts]);

  useEffect(() => {
    if (runningOperation) {
      lastRunningOperationIdRef.current = runningOperation.id;
      if (logStreamOperationIdRef.current !== runningOperation.id) {
        startLogStream(runningOperation.id);
      }
    }
  }, [runningOperation, startLogStream]);

  useEffect(() => () => {
    if (logStream) {
      logStream.close();
    }
  }, [logStream]);

  useEffect(() => {
    if (showLogs && logs) {
      const logContainer = document.getElementById('log-container');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }
  }, [logs, showLogs]);

  useEffect(() => {
    const hasRunning = operations.some((op) => op.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [operations]);

  const getElapsedSeconds = (startedAt: string) => {
    return Math.floor((now - new Date(startedAt).getTime()) / 1000);
  };

  const startOperation = async () => {
    if (!selectedConfig) {
      addDangerAlert('Please select an ImageSetConfiguration file');
      return;
    }

    const flagsValidationError = getOptionalFlagsValidationError(optionalFlags);
    if (flagsValidationError) {
      addDangerAlert(flagsValidationError);
      return;
    }

    const optionalFlagsPayload = buildOptionalFlagsPayload(optionalFlags);
    if (optionalFlagsPayload === null) {
      addDangerAlert('Invalid optional flags');
      return;
    }

    try {
      setLoading(true);
      const response = await axios.post('/api/operations/start', {
        configFile: selectedConfig,
        mirrorDestinationSubdir: mirrorDestinationSubdir.trim() || undefined,
        ...(Object.keys(optionalFlagsPayload).length > 0
          ? { optionalFlags: optionalFlagsPayload }
          : {}),
      });

      addSuccessAlert('Operation started successfully!');
      setShowLogs(true);
      fetchOperations();
      void fetchFolders();
      setMirrorDestinationSubdir('');

      if (response.data.status === 'running') {
        const logInterval = setInterval(async () => {
          try {
            const logResponse = await axios.get(`/api/operations/${response.data.id}/logs`);
            setLogs(logResponse.data.logs || '');
          } catch (error) {
            console.error('Error polling logs:', error);
          }
        }, 2000);

        setTimeout(() => clearInterval(logInterval), 300000);
      }
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
      console.error('Error starting operation:', error);
      addDangerAlert(
        `Failed to start operation: ${err.response?.data?.error || err.response?.data?.message || err.message}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const deleteConfiguration = (configName: string) => {
    setDeleteFilename(configName);
    setDeleteOperationId(null);
    setShowDeleteModal(true);
  };

  const confirmDeleteConfig = async () => {
    try {
      await axios.delete(`/api/config/delete/${encodeURIComponent(deleteFilename)}`);
      addSuccessAlert(`Configuration "${deleteFilename}" deleted successfully!`);
      fetchConfigurations();

      if (selectedConfig === deleteFilename) {
        setSelectedConfig('');
      }

      setShowDeleteModal(false);
      setDeleteFilename('');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      console.error('Error deleting configuration:', error);
      addDangerAlert(`Failed to delete configuration: ${err.response?.data?.message || err.message}`);
    }
  };

  const stopOperation = async (operationId: string) => {
    try {
      await axios.post(`/api/operations/${operationId}/stop`);
      fetchOperations();
    } catch (error) {
      console.error('Error stopping operation:', error);
      addDangerAlert('Failed to stop operation');
    }
  };

  const promptStopOperation = (operationId: string) => {
    setStopOperationId(operationId);
    setShowStopModal(true);
  };

  const confirmStopOperation = async () => {
    if (!stopOperationId) return;
    await stopOperation(stopOperationId);
    setShowStopModal(false);
    setStopOperationId(null);
  };

  const promptDeleteOperation = (operationId: string) => {
    setDeleteOperationId(operationId);
    setDeleteFilename('');
    setShowDeleteModal(true);
  };

  const confirmDeleteOperation = async () => {
    if (!deleteOperationId) return;
    try {
      await axios.delete(`/api/operations/${deleteOperationId}`);
      setArtifacts((prev) => {
        const next = { ...prev };
        delete next[deleteOperationId];
        return next;
      });
      addSuccessAlert('Operation deleted successfully!');
      fetchOperations();
      setShowDeleteModal(false);
      setDeleteOperationId(null);
    } catch (error) {
      console.error('Error deleting operation:', error);
      addDangerAlert('Failed to delete operation');
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'success':
        return <Label status="success">Success</Label>;
      case 'running':
        return <Label status="custom" icon={<SyncAltIcon style={{ color: 'var(--pf-t--global--icon--color--inverse)' }} />}>Running</Label>;
      case 'failed':
        return <Label status="danger">Failed</Label>;
      case 'stopped':
        return <Label status="warning">Stopped</Label>;
      default:
        return <Label color="grey">Unknown</Label>;
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  /**
   * Recursively build PatternFly TreeViewDataItem[] from the flat fetched map.
   * Directories that haven't been expanded yet get a placeholder child so PF
   * renders an expand arrow for them.
   */
  const buildWorkingDirTree = (
    items: WorkingDirItem[],
    wdState: WorkingDirState,
  ): TreeViewDataItem[] =>
    items.map(item => {
      const key = item.path || 'root';
      const isLoading = wdState.loadingPaths.has(key);
      const fetchedChildren = wdState.fetched[key];

      let children: TreeViewDataItem[] | undefined;
      if (item.type === 'directory') {
        if (isLoading) {
          children = [{ id: `${key}-loading`, name: <span><Spinner size="sm" /> Loading…</span> }];
        } else if (fetchedChildren) {
          children = fetchedChildren.length > 0
            ? buildWorkingDirTree(fetchedChildren, wdState)
            : [{ id: `${key}-empty`, name: <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>Empty directory</span> }];
        } else if (item.hasChildren) {
          // Not yet fetched — placeholder so PF renders an expand arrow.
          children = [{ id: `${key}-placeholder`, name: '' }];
        } else {
          children = [];
        }
      }

      const label = (
        <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
          <FlexItem>
            {item.type === 'directory' ? <FolderIcon /> : <FileIcon />}
          </FlexItem>
          <FlexItem>{item.name}</FlexItem>
          {item.sizeBytes !== undefined && (
            <FlexItem>
              <span style={{ color: 'var(--pf-t--global--text--color--subtle)', fontSize: '0.85em' }}>
                {formatBytes(item.sizeBytes)}
              </span>
            </FlexItem>
          )}
        </Flex>
      );

      return {
        id: key,
        name: label,
        children,
        expandedIcon: item.type === 'directory' ? <FolderOpenIcon /> : undefined,
      } as TreeViewDataItem;
    });

  const scrollToOperations = () => {
    document.getElementById('operation-history-card')?.scrollIntoView({ behavior: 'smooth' });
  };

  const getMirrorFullPath = (mirrorDestination: string) => {
    if (hostDataDir && mirrorDestination.startsWith('/app/data')) {
      return mirrorDestination.replace('/app/data', hostDataDir);
    }
    return mirrorDestination;
  };

  const copyMirrorPath = async (mirrorDestination: string) => {
    const fullPath = getMirrorFullPath(mirrorDestination);

    try {
      await navigator.clipboard.writeText(fullPath);
      addSuccessAlert('Full path copied to clipboard!');
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = fullPath;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        addSuccessAlert('Full path copied to clipboard!');
      } catch {
        addDangerAlert('Failed to copy path');
      }
      document.body.removeChild(textArea);
    }
  };

  const isDeleteConfig = deleteFilename && !deleteOperationId;

  const filteredOps = operations.filter(op => {
    if (opsFilter === 'all') return true;
    return op.status === opsFilter;
  });

  const toggleOpChecked = (id: string) => {
    setCheckedOpIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allFilteredOpsChecked = filteredOps.length > 0 && filteredOps.every(op => checkedOpIds.has(op.id));
  const someFilteredOpsChecked = filteredOps.some(op => checkedOpIds.has(op.id));

  const toggleSelectAllOps = () => {
    if (allFilteredOpsChecked) {
      setCheckedOpIds(prev => {
        const next = new Set(prev);
        for (const op of filteredOps) next.delete(op.id);
        return next;
      });
    } else {
      setCheckedOpIds(prev => {
        const next = new Set(prev);
        for (const op of filteredOps) next.add(op.id);
        return next;
      });
    }
  };

  const bulkDeleteOperations = async (ids: string[]) => {
    setBulkDeleting(true);
    try {
      await Promise.all(ids.map(id => axios.delete(`/api/operations/${id}`)));
      setCheckedOpIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setArtifacts((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      addSuccessAlert(`Deleted ${ids.length} operation${ids.length > 1 ? 's' : ''}`);
      await fetchOperations();
    } catch {
      addDangerAlert('Failed to delete some operations');
    } finally {
      setBulkDeleting(false);
      setBulkDeleteTarget(null);
    }
  };

  const confirmBulkDelete = () => {
    if (bulkDeleteTarget === 'selected') {
      const ids = filteredOps.filter(op => checkedOpIds.has(op.id)).map(op => op.id);
      void bulkDeleteOperations(ids);
    } else if (bulkDeleteTarget === 'all') {
      void bulkDeleteOperations(filteredOps.map(op => op.id));
    }
  };

  const bulkDeleteCount = bulkDeleteTarget === 'all'
    ? filteredOps.length
    : filteredOps.filter(op => checkedOpIds.has(op.id)).length;

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h2">
              <SyncAltIcon /> Mirror Operations
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          Run mirror operations using saved configurations and track their progress.
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg">
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h3">
              Start New Operation
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <FormGroup label="ImageSetConfiguration File" fieldId="config-select">
            <InputGroup>
              <InputGroupItem isFill>
                <Select
                  id="config-select"
                  isOpen={configSelectOpen}
                  selected={selectedConfig}
                  onSelect={(_e, val) => {
                    setSelectedConfig(val as string);
                    setConfigSelectOpen(false);
                  }}
                  onOpenChange={(open) => setConfigSelectOpen(open)}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setConfigSelectOpen(prev => !prev)}
                      isExpanded={configSelectOpen}
                      aria-label="Select ImageSetConfiguration file"
                      style={{ width: '100%' }}
                    >
                      {selectedConfig
                        ? `${selectedConfig} (${availableConfigs.find(c => c.name === selectedConfig)?.size || ''})`
                        : 'Select an ImageSetConfiguration file...'}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    {availableConfigs.map(config => (
                      <SelectOption key={config.name} value={config.name}>
                        {`${config.name} (${config.size})`}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </InputGroupItem>
              {selectedConfig && (
                <InputGroupItem>
                  <Tooltip content="Delete configuration">
                    <Button
                      variant="plain"
                      icon={<TrashIcon />}
                      onClick={() => deleteConfiguration(selectedConfig)}
                      aria-label="Delete configuration"
                    />
                  </Tooltip>
                </InputGroupItem>
              )}
            </InputGroup>
          </FormGroup>

          <Flex alignItems={{ default: 'alignItemsFlexEnd' }} className="pf-v6-u-mt-md">
            <FlexItem>
              <FormGroup
                label={
                  <FormGroupInfoLabel
                    text="Mirror Destination Folder"
                    ariaLabel="More info about mirror destination folder"
                    bodyContent="Mirror output is saved to data/mirrors/<folder>. Defaults to &quot;default&quot; if unchanged. Select an existing folder or create a new one from the dropdown."
                  />
                }
                fieldId="mirror-subdir"
              >
                <Select
                  id="mirror-subdir"
                  isOpen={folderSelectOpen}
                  selected={mirrorDestinationSubdir || undefined}
                  onSelect={(_e, val) => {
                    if (val === '__create__') return;
                    setMirrorDestinationSubdir(val as string);
                    setFolderSelectOpen(false);
                  }}
                  onOpenChange={(open) => {
                    setFolderSelectOpen(open);
                    if (!open) {
                      setFolderCreateMode(false);
                      setNewFolderName('');
                    }
                  }}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setFolderSelectOpen((prev) => !prev)}
                      isExpanded={folderSelectOpen}
                      style={{ width: '250px' }}
                    >
                      {mirrorDestinationSubdir || 'default'}
                    </MenuToggle>
                  )}
                >
                  {folderCreateMode ? (
                    <div style={{ padding: 'var(--pf-t--global--spacer--sm)', display: 'flex', gap: 'var(--pf-t--global--spacer--xs)' }}>
                      <TextInput
                        aria-label="New folder name"
                        placeholder="Enter folder name"
                        value={newFolderName}
                        onChange={(_e, v) => setNewFolderName(v)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newFolderName.trim()) {
                            void confirmCreateFolder(newFolderName);
                          }
                          if (e.key === 'Escape') {
                            setFolderCreateMode(false);
                            setNewFolderName('');
                          }
                        }}
                      />
                      <Button
                        variant="plain"
                        icon={<CheckIcon />}
                        isDisabled={!newFolderName.trim()}
                        onClick={() => void confirmCreateFolder(newFolderName)}
                      />
                      <Button
                        variant="plain"
                        icon={<TimesIcon />}
                        onClick={() => {
                          setFolderCreateMode(false);
                          setNewFolderName('');
                        }}
                      />
                    </div>
                  ) : (
                    <SelectList>
                      {availableFolders.map((folder) => (
                        <SelectOption key={folder} value={folder}>{folder}</SelectOption>
                      ))}
                      {availableFolders.length > 0 && <Divider />}
                      <SelectOption
                        value="__create__"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFolderCreateMode(true);
                          setNewFolderName('');
                        }}
                      >
                        <PlusCircleIcon className="pf-v6-u-mr-xs" /> Create new folder...
                      </SelectOption>
                    </SelectList>
                  )}
                </Select>
              </FormGroup>
            </FlexItem>
            <FlexItem>
              <ExpandableSectionToggle
                isExpanded={advancedOptionsExpanded}
                onToggle={(expanded) => setAdvancedOptionsExpanded(expanded)}
                toggleId="advanced-options-toggle"
                contentId="advanced-options-content"
                isDetached
              >
                Advanced Options
              </ExpandableSectionToggle>
            </FlexItem>
            <FlexItem>
              <Button
                variant="primary"
                icon={loading ? <Spinner size="md" /> : <PlayIcon />}
                onClick={startOperation}
                isDisabled={!selectedConfig || loading}
              >
                Start Operation
              </Button>
            </FlexItem>
          </Flex>

          <ExpandableSection
            className="pf-v6-u-mt-md"
            isExpanded={advancedOptionsExpanded}
            isDetached
            direction="down"
            toggleId="advanced-options-toggle"
            contentId="advanced-options-content"
          >
            <FormGroup
              label={
                <FormGroupInfoLabel
                  text="Remove signatures"
                  ariaLabel="More info about remove signatures"
                  bodyContent="When enabled, image signatures are not copied to the mirror destination."
                />
              }
              fieldId="flag-remove-signatures"
              className="pf-v6-u-mb-md"
            >
              <Switch
                id="flag-remove-signatures"
                isChecked={optionalFlags.removeSignatures}
                onChange={(_e, checked) =>
                  setOptionalFlags((prev) => ({ ...prev, removeSignatures: checked }))
                }
                aria-label="Enable remove signatures"
              />
            </FormGroup>

            <FormGroup
              label={
                <FormGroupInfoLabel
                  text="Image timeout"
                  ariaLabel="More info about image timeout"
                  bodyContent="Maximum time to wait when pulling each image before oc-mirror gives up on that attempt. Default is 10 minutes."
                />
              }
              fieldId="flag-image-timeout"
              className="pf-v6-u-mb-md"
            >
              <Switch
                id="flag-image-timeout"
                isChecked={optionalFlags.imageTimeoutEnabled}
                onChange={(_e, checked) =>
                  setOptionalFlags((prev) => ({ ...prev, imageTimeoutEnabled: checked }))
                }
                aria-label="Enable image timeout"
              />
              {optionalFlags.imageTimeoutEnabled && (
                <div className="pf-v6-u-mt-sm">
                  <Flex spaceItems={{ default: 'spaceItemsMd' }}>
                    <FlexItem>
                      <NumberInput
                        id="flag-image-timeout-minutes"
                        value={
                          optionalFlags.imageTimeoutMinutes
                            ? Number(optionalFlags.imageTimeoutMinutes)
                            : 0
                        }
                        min={0}
                        onMinus={() =>
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutMinutes: adjustDigitField(prev.imageTimeoutMinutes, -1, 0),
                          }))
                        }
                        onPlus={() =>
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutMinutes: adjustDigitField(prev.imageTimeoutMinutes, 1, 0),
                          }))
                        }
                        onChange={(e: React.FormEvent<HTMLInputElement>) => {
                          const val = (e.target as HTMLInputElement).value;
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutMinutes: sanitizeDigitsInput(val),
                          }));
                        }}
                        widthChars={4}
                        unit="m"
                        inputAriaLabel="Image timeout minutes"
                        minusBtnAriaLabel="Decrease image timeout minutes"
                        plusBtnAriaLabel="Increase image timeout minutes"
                      />
                    </FlexItem>
                    <FlexItem>
                      <NumberInput
                        id="flag-image-timeout-seconds"
                        value={
                          optionalFlags.imageTimeoutSeconds
                            ? Number(optionalFlags.imageTimeoutSeconds)
                            : 0
                        }
                        min={0}
                        onMinus={() =>
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutSeconds: adjustDigitField(prev.imageTimeoutSeconds, -1, 0),
                          }))
                        }
                        onPlus={() =>
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutSeconds: adjustDigitField(prev.imageTimeoutSeconds, 1, 0),
                          }))
                        }
                        onChange={(e: React.FormEvent<HTMLInputElement>) => {
                          const val = (e.target as HTMLInputElement).value;
                          setOptionalFlags((prev) => ({
                            ...prev,
                            imageTimeoutSeconds: sanitizeDigitsInput(val),
                          }));
                        }}
                        widthChars={4}
                        unit="s"
                        inputAriaLabel="Image timeout seconds"
                        minusBtnAriaLabel="Decrease image timeout seconds"
                        plusBtnAriaLabel="Increase image timeout seconds"
                      />
                    </FlexItem>
                  </Flex>
                </div>
              )}
            </FormGroup>

            <FormGroup
              label={
                <FormGroupInfoLabel
                  text="Retry delay"
                  ariaLabel="More info about retry delay"
                  bodyContent={
                    <div>
                      Fixed wait, in seconds, before each retry after a failure.
                      <br />
                      <br />
                      Set to <strong>0</strong> for oc-mirror&apos;s default behavior: the wait
                      starts short and roughly doubles after each failed attempt
                      (for example 1s → 2s → 4s), instead of waiting the same amount every time.
                    </div>
                  }
                />
              }
              fieldId="flag-retry-delay"
              className="pf-v6-u-mb-md"
            >
              <Switch
                id="flag-retry-delay"
                isChecked={optionalFlags.retryDelayEnabled}
                onChange={(_e, checked) =>
                  setOptionalFlags((prev) => ({ ...prev, retryDelayEnabled: checked }))
                }
                aria-label="Enable retry delay"
              />
              {optionalFlags.retryDelayEnabled && (
                <div className="pf-v6-u-mt-sm">
                  <NumberInput
                    id="flag-retry-delay-seconds"
                    value={
                      optionalFlags.retryDelaySeconds
                        ? Number(optionalFlags.retryDelaySeconds)
                        : 0
                    }
                    min={0}
                    onMinus={() =>
                      setOptionalFlags((prev) => ({
                        ...prev,
                        retryDelaySeconds: adjustDigitField(prev.retryDelaySeconds, -1, 0),
                      }))
                    }
                    onPlus={() =>
                      setOptionalFlags((prev) => ({
                        ...prev,
                        retryDelaySeconds: adjustDigitField(prev.retryDelaySeconds, 1, 0),
                      }))
                    }
                    onChange={(e: React.FormEvent<HTMLInputElement>) => {
                      const val = (e.target as HTMLInputElement).value;
                      setOptionalFlags((prev) => ({
                        ...prev,
                        retryDelaySeconds: sanitizeDigitsInput(val),
                      }));
                    }}
                    widthChars={4}
                    unit="s"
                    inputAriaLabel="Retry delay seconds"
                    minusBtnAriaLabel="Decrease retry delay"
                    plusBtnAriaLabel="Increase retry delay"
                  />
                </div>
              )}
            </FormGroup>

            <FormGroup
              label={
                <FormGroupInfoLabel
                  text="Retry times"
                  ariaLabel="More info about retry times"
                  bodyContent="How many times oc-mirror retries a failed image pull. Default is 5."
                />
              }
              fieldId="flag-retry-times"
            >
              <Switch
                id="flag-retry-times"
                isChecked={optionalFlags.retryTimesEnabled}
                onChange={(_e, checked) =>
                  setOptionalFlags((prev) => ({ ...prev, retryTimesEnabled: checked }))
                }
                aria-label="Enable retry times"
              />
              {optionalFlags.retryTimesEnabled && (
                <div className="pf-v6-u-mt-sm">
                  <NumberInput
                    id="flag-retry-times-value"
                    value={
                      optionalFlags.retryTimesValue
                        ? Number(optionalFlags.retryTimesValue)
                        : 0
                    }
                    min={0}
                    onMinus={() =>
                      setOptionalFlags((prev) => {
                        const current = prev.retryTimesValue
                          ? Number(prev.retryTimesValue)
                          : 0;
                        return {
                          ...prev,
                          retryTimesValue: String(Math.max(0, current - 1)),
                        };
                      })
                    }
                    onPlus={() =>
                      setOptionalFlags((prev) => {
                        const current = prev.retryTimesValue
                          ? Number(prev.retryTimesValue)
                          : 0;
                        return { ...prev, retryTimesValue: String(current + 1) };
                      })
                    }
                    onChange={(e: React.FormEvent<HTMLInputElement>) => {
                      const val = (e.target as HTMLInputElement).value;
                      setOptionalFlags((prev) => ({
                        ...prev,
                        retryTimesValue: sanitizeDigitsInput(val),
                      }));
                    }}
                    widthChars={4}
                    inputAriaLabel="Retry times"
                    minusBtnAriaLabel="Decrease retry times"
                    plusBtnAriaLabel="Increase retry times"
                  />
                </div>
              )}
            </FormGroup>
          </ExpandableSection>
        </CardBody>
      </Card>

      <Card className="pf-v6-u-mt-lg" id="operation-history-card">
        <CardHeader>
          <CardTitle>
            <Title headingLevel="h3">
              Operations
            </Title>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem>
                <Select
                  isOpen={opsFilterOpen}
                  selected={opsFilter}
                  onSelect={(_e, val) => {
                    setOpsFilter(val as string);
                    setOpsFilterOpen(false);
                  }}
                  onOpenChange={(open) => setOpsFilterOpen(open)}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setOpsFilterOpen(prev => !prev)}
                      isExpanded={opsFilterOpen}
                      aria-label="Filter operations"
                    >
                      {{ all: 'All Operations', running: 'Running', success: 'Successful', failed: 'Failed', stopped: 'Stopped' }[opsFilter] || 'All Operations'}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    <SelectOption value="all">All Operations</SelectOption>
                    <SelectOption value="running">Running</SelectOption>
                    <SelectOption value="success">Successful</SelectOption>
                    <SelectOption value="failed">Failed</SelectOption>
                    <SelectOption value="stopped">Stopped</SelectOption>
                  </SelectList>
                </Select>
              </ToolbarItem>
              <ToolbarGroup align={{ default: 'alignEnd' }}>
                {someFilteredOpsChecked && (
                  <ToolbarItem>
                    <Button
                      variant="secondary"
                      icon={<TrashAltIcon />}
                      isDanger
                      onClick={() => setBulkDeleteTarget('selected')}
                    >
                      Delete Selected ({filteredOps.filter(op => checkedOpIds.has(op.id)).length})
                    </Button>
                  </ToolbarItem>
                )}
                {filteredOps.length > 0 && (
                  <ToolbarItem>
                    <Button
                      variant="secondary"
                      icon={<TrashAltIcon />}
                      isDanger
                      onClick={() => setBulkDeleteTarget('all')}
                    >
                      Delete All
                    </Button>
                  </ToolbarItem>
                )}
              </ToolbarGroup>
            </ToolbarContent>
          </Toolbar>
        </CardBody>
        <CardBody className="pf-v6-u-p-0">
          {filteredOps.length === 0 ? (
            <EmptyState>
              <SearchIcon />
              <EmptyStateBody>No operations found.</EmptyStateBody>
            </EmptyState>
          ) : (
            <Table aria-label="Operation history" variant="compact" borders={false}>
              <Thead>
                <Tr>
                  <Th
                    select={{
                      onSelect: toggleSelectAllOps,
                      isSelected: allFilteredOpsChecked,
                    }}
                    aria-label="Select all"
                  />
                  <Th>Operation</Th>
                  <Th>Config</Th>
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {filteredOps.map((op, rowIndex) => (
                  <Tr key={op.id}>
                    <Td
                      select={{
                        rowIndex,
                        onSelect: () => { toggleOpChecked(op.id); },
                        isSelected: checkedOpIds.has(op.id),
                      }}
                    />
                    <Td dataLabel="Operation">
                      {op.name}
                    </Td>
                    <Td dataLabel="Config">
                      <Button
                        variant="link"
                        isInline
                        component="a"
                        href={`/api/config/download/${encodeURIComponent(op.configFile)}`}
                        download={op.configFile}
                      >
                        {op.configFile}
                      </Button>
                    </Td>
                    <Td dataLabel="Status">
                      {getStatusLabel(op.status)}
                    </Td>
                    <Td dataLabel="Started">
                      <Timestamp date={new Date(op.startedAt)} tooltip={{ variant: 'default' }} />
                    </Td>
                    <Td dataLabel="Duration">
                      <OutlinedClockIcon /> {op.status === 'running'
                        ? formatDuration(getElapsedSeconds(op.startedAt))
                        : formatDuration(op.duration)}
                    </Td>
                    <Td isActionCell>
                      <Dropdown
                        isOpen={!!kebabOpen[op.id]}
                        onOpenChange={(open) => {
                          setKebabOpen((prev) => ({ ...prev, [op.id]: open }));
                        }}
                        toggle={(toggleRef) => (
                          <MenuToggle
                            ref={toggleRef}
                            variant="plain"
                            onClick={() => setKebabOpen((prev) => ({ ...prev, [op.id]: !prev[op.id] }))}
                            isExpanded={!!kebabOpen[op.id]}
                            icon={<EllipsisVIcon />}
                            aria-label={`Actions for ${op.name}`}
                          />
                        )}
                        shouldFocusToggleOnSelect
                        popperProps={{ position: 'right' }}
                      >
                        <DropdownList>
                          <DropdownItem
                            key={`${op.id}-logs`}
                            icon={<ListIcon />}
                            onClick={() => {
                              setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                              void fetchLogs(op.id);
                              setShowLogs(true);
                              setTimeout(() => {
                                document.getElementById('operation-logs-card')?.scrollIntoView({ behavior: 'smooth' });
                              }, 100);
                            }}
                          >
                            View Logs
                          </DropdownItem>
                          {op.status === 'success' && op.mirrorDestination && (
                            <DropdownItem
                              key={`${op.id}-copy-location`}
                              icon={<CopyIcon />}
                              onClick={() => {
                                setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                void copyMirrorPath(op.mirrorDestination!);
                              }}
                            >
                              Copy Location
                            </DropdownItem>
                          )}
                          {op.status === 'success' && op.mirrorDestination && (() => {
                            const listing = artifacts[op.id];
                            const listingReady =
                              listing &&
                              !listing.error &&
                              Array.isArray(listing.artifacts) &&
                              listing.artifacts.length > 0;

                            // Prefer live listing (includes size). Fall back to artifactFiles
                            // from the operation record so download links appear even if the
                            // listing request is slow/failed — oc-mirror always reuses names
                            // like mirror_000001.tar; persisted copies are served by op id.
                            const archiveItems: { filename: string; sizeBytes?: number; downloadUrl: string }[] =
                              listingReady
                                ? listing!.artifacts
                                : (op.artifactFiles ?? []).map((filename) => ({
                                    filename,
                                    downloadUrl:
                                      `/api/operations/${encodeURIComponent(op.id)}` +
                                      `/artifacts/${encodeURIComponent(filename)}/download`,
                                  }));

                            if (archiveItems.length > 0) {
                              return archiveItems.map((artifact) => {
                                // Prefer the persisted name (mirror_<shortId>.tar) so the
                                // saved file matches the operation id shown in the table.
                                const downloadName = artifact.filename;
                                const sizeLabel =
                                  typeof artifact.sizeBytes === 'number'
                                    ? ` (${formatBytes(artifact.sizeBytes)})`
                                    : '';

                                return (
                                  <DropdownItem
                                    key={`${op.id}-archive-${artifact.filename}`}
                                    icon={<DownloadIcon />}
                                    onClick={(event) => {
                                      // PatternFly menu selection closes/unmounts the item on
                                      // click. If we rely on <a href>, that unmount cancels the
                                      // browser download — especially for multi-GB archives.
                                      event.preventDefault();
                                      setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                      const url = artifact.downloadUrl;
                                      const name = downloadName;
                                      window.setTimeout(() => {
                                        const link = document.createElement('a');
                                        link.href = url;
                                        link.download = name;
                                        link.rel = 'noopener';
                                        document.body.appendChild(link);
                                        link.click();
                                        link.remove();
                                      }, 0);
                                    }}
                                  >
                                    {archiveItems.length === 1
                                      ? `Download ${artifact.filename}${sizeLabel}`
                                      : `${artifact.filename}${sizeLabel}`}
                                  </DropdownItem>
                                );
                              });
                            }

                            // Only show the spinner while a request is actually in flight.
                            // Previously `!listing` alone caused permanent "Loading archives…"
                            // when onOpenChange never started the fetch.
                            if (artifactsLoading[op.id]) {
                              return (
                                <DropdownItem
                                  key={`${op.id}-archives-loading`}
                                  isDisabled
                                  icon={<DownloadIcon />}
                                >
                                  <Spinner size="sm" aria-label="Loading archives" />{' '}Loading archives…
                                </DropdownItem>
                              );
                            }

                            if (listing?.error || listing) {
                              return (
                                <DropdownItem
                                  key={`${op.id}-archives-empty`}
                                  isDisabled
                                  icon={<DownloadIcon />}
                                >
                                  No archives available
                                </DropdownItem>
                              );
                            }

                            // Kebab just opened; effect will fetch. Brief pending state.
                            return (
                              <DropdownItem
                                key={`${op.id}-archives-pending`}
                                isDisabled
                                icon={<DownloadIcon />}
                              >
                                <Spinner size="sm" aria-label="Loading archives" />{' '}Loading archives…
                              </DropdownItem>
                            );
                          })()}
                          {op.status === 'success' && op.mirrorDestination && (
                            <DropdownItem
                              key={`${op.id}-working-dir`}
                              icon={<FolderIcon />}
                              onClick={() => {
                                setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                setWorkingDirOpId(op.id);
                                setShowWorkingDir(true);
                                // Fetch root level if not already fetched.
                                if (!workingDirs[op.id]?.fetched['root']) {
                                  void fetchWorkingDirPath(op.id, '');
                                }
                                setTimeout(() => {
                                  document.getElementById('operation-working-dir-card')?.scrollIntoView({ behavior: 'smooth' });
                                }, 100);
                              }}
                            >
                              View Working Dir
                            </DropdownItem>
                          )}
                          <Divider key={`${op.id}-div`} component="li" />
                          {op.status === 'running' && (
                            <DropdownItem
                              key={`${op.id}-stop`}
                              icon={<StopIcon />}
                              isDanger
                              onClick={() => {
                                setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                                promptStopOperation(op.id);
                              }}
                            >
                              Stop
                            </DropdownItem>
                          )}
                          <DropdownItem
                            key={`${op.id}-delete`}
                            icon={<TrashIcon />}
                            isDanger
                            onClick={() => {
                              setKebabOpen((prev) => ({ ...prev, [op.id]: false }));
                              promptDeleteOperation(op.id);
                            }}
                          >
                            Delete
                          </DropdownItem>
                        </DropdownList>
                      </Dropdown>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {showLogs && (
        <Card className="pf-v6-u-mt-lg" id="operation-logs-card">
          <CardHeader>
            <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
              <FlexItem>
                <CardTitle>
                  <Title headingLevel="h4">
                    Operation Logs
                  </Title>
                </CardTitle>
              </FlexItem>
              <FlexItem>
                <Button variant="secondary" icon={<AngleUpIcon />} onClick={scrollToOperations}>
                  Back to Top
                </Button>
              </FlexItem>
            </Flex>
          </CardHeader>
          <CardBody>
            <div id="log-container" style={{ maxHeight: '400px', overflow: 'auto' }}>
              <CodeBlock>
                <CodeBlockCode>{logs || 'No logs available'}</CodeBlockCode>
              </CodeBlock>
            </div>
          </CardBody>
        </Card>
      )}

      {showWorkingDir && workingDirOpId && (() => {
        const wdState = workingDirs[workingDirOpId];
        const rootItems = wdState?.fetched['root'];
        const isRootLoading = !wdState || wdState.loadingPaths.has('root');
        const hostPath = wdState?.hostWorkingDirPath ?? wdState?.workingDirPath ?? '';

        return (
          <Card className="pf-v6-u-mt-lg" id="operation-working-dir-card">
            <CardHeader>
              <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem>
                  <CardTitle>
                    <Title headingLevel="h4">Working Directory</Title>
                  </CardTitle>
                </FlexItem>
                <FlexItem>
                  <Button variant="secondary" icon={<AngleUpIcon />} onClick={scrollToOperations}>
                    Back to Top
                  </Button>
                </FlexItem>
              </Flex>
            </CardHeader>
            <CardBody>
              {wdState?.error ? (
                <Alert variant="warning" isInline title={wdState.error} />
              ) : (
                <>
                  {hostPath && (
                    <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }} className="pf-v6-u-mb-md">
                      <FlexItem>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.9em', color: 'var(--pf-t--global--text--color--subtle)' }}>
                          {hostPath}
                        </span>
                      </FlexItem>
                      <FlexItem>
                        <Tooltip content="Copy working-dir path">
                          <Button
                            variant="plain"
                            aria-label="Copy working-dir path"
                            icon={<CopyIcon />}
                            onClick={() => void copyMirrorPath(wdState?.workingDirPath ?? '')}
                          />
                        </Tooltip>
                      </FlexItem>
                    </Flex>
                  )}
                  {isRootLoading ? (
                    <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
                      <FlexItem><Spinner size="md" aria-label="Loading working-dir" /></FlexItem>
                      <FlexItem>Loading directory structure…</FlexItem>
                    </Flex>
                  ) : rootItems && rootItems.length > 0 ? (
                    <div style={{ maxHeight: '500px', overflow: 'auto' }}>
                      <TreeView
                        data={buildWorkingDirTree(rootItems, wdState!)}
                        hasGuides
                        onExpand={(_evt, item) => {
                          const itemPath = item.id as string;
                          // Only fetch if we have a path, haven't fetched it yet,
                          // and it's not already in flight.
                          if (
                            itemPath &&
                            !wdState?.fetched[itemPath] &&
                            !wdState?.loadingPaths.has(itemPath)
                          ) {
                            void fetchWorkingDirPath(workingDirOpId, itemPath);
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                      working-dir is empty.
                    </span>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        );
      })()}

      <Modal
        variant={ModalVariant.small}
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteFilename('');
          setDeleteOperationId(null);
        }}
        aria-label="Delete confirmation"
      >
        <ModalHeader title={isDeleteConfig ? 'Delete ImageSetConfiguration File' : 'Delete Operation Record'} />
        <ModalBody>
          {isDeleteConfig ? (
            <>
              <p>
                Are you sure you want to delete <span style={{ fontWeight: 600 }}>&quot;{deleteFilename}&quot;</span>? This file will be permanently removed.
              </p>
              <Alert variant="warning" isInline isPlain title="This action cannot be undone." className="pf-v6-u-mt-md" />
            </>
          ) : (
            <>
              <p>
                Are you sure you want to delete the record for operation <span style={{ fontWeight: 600 }}>&quot;{deleteOperationId}&quot;</span>? The operation logs will be permanently removed.
              </p>
              <Alert variant="warning" isInline isPlain title="This action cannot be undone." className="pf-v6-u-mt-md" />
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={isDeleteConfig ? confirmDeleteConfig : confirmDeleteOperation}
          >
            Delete
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setShowDeleteModal(false);
              setDeleteFilename('');
              setDeleteOperationId(null);
            }}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={bulkDeleteTarget !== null}
        onClose={() => setBulkDeleteTarget(null)}
        aria-label="Confirm bulk deletion"
      >
        <ModalHeader title="Delete Operations" />
        <ModalBody>
          <p>
            Are you sure you want to delete{' '}
            <strong>
              {bulkDeleteTarget === 'all' ? 'all' : bulkDeleteCount}
            </strong>{' '}
            operation{bulkDeleteCount !== 1 ? 's' : ''}? This action cannot be undone.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={confirmBulkDelete}
            isDisabled={bulkDeleting}
            isLoading={bulkDeleting}
          >
            Delete
          </Button>
          <Button variant="link" onClick={() => setBulkDeleteTarget(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={showStopModal}
        onClose={() => {
          setShowStopModal(false);
          setStopOperationId(null);
        }}
        aria-label="Stop confirmation"
      >
        <ModalHeader title="Stop Operation" />
        <ModalBody>
          <p>
            Are you sure you want to stop the running operation <span style={{ fontWeight: 600 }}>&quot;{stopOperationId}&quot;</span>?
          </p>
          <p className="pf-v6-u-mt-md" style={{ display: 'flex', alignItems: 'center', gap: 'var(--pf-t--global--spacer--xs)' }}>
            <InfoCircleIcon style={{ flexShrink: 0 }} /> You can start a new operation with the same configuration.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={confirmStopOperation}>
            Stop Operation
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setShowStopModal(false);
              setStopOperationId(null);
            }}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default MirrorOperations;
