import { createResultPreviewPolicy } from '@industrial-agent-harness/viewer-core/result-preview';
import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUp,
  Bug,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  Maximize,
  PanelsTopLeft,
  Pin,
  Columns2,
  Minimize,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Settings2,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AgentEvent,
  ResultOpenRequest,
  ChatHistory,
  ChatSummary,
  SessionStatus,
  ChatTurn,
  BrokerResult,
  CapabilityDetail,
  DomainOption,
  ProjectBinding,
  PromptImage,
} from '@industrial-agent-harness/viewer-builtin/api';
import {
  useImageAttachments,
  ImageAttachButton,
  ImageThumbnails,
} from './components/ImageAttachments';
import { AgentLogPanel } from './components/AgentLogPanel';
import { AgentFlow } from './components/AgentFlow';
import { ChatAgentSelect } from './components/AgentSettings';
import { BrokerCall } from './components/BrokerCall';
import { TodoList } from './components/TodoList';
import { DomainManager } from './components/DomainManager';
import { CapabilityCenter, type CapabilitySection } from './components/CapabilityCenter';
import { MessageRail } from './components/MessageRail';
import { WindowControls } from './components/WindowControls';
import { CoreUpdatePanel } from './components/CoreUpdatePanel';
import { ComputerUseSettings } from './components/ComputerUseSettings';
import { ModelSettings } from './components/ModelSettings';
import { RemoteTaskStatus } from './components/RemoteExecution';
import { ProjectDetails } from './components/ProjectDetails';
import { CreateProjectModal } from './components/CreateProjectModal';
import { WorkspaceDivider } from './components/WorkspaceDivider';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { openWorkspaceFile } from './workspace-files';
import {
  WorkspaceFileView,
  type WorkspaceFile,
  type WorkspaceViewState,
} from './components/WorkspaceFileView';
import { DomainPill } from './components/DomainPill';
import { MessageActions } from './components/MessageActions';
import { appendDisplayEvents, latestEvent } from './agent-events';
import { mergeHistoryEvents } from './chat-history';
import { useLanguage } from './i18n/I18nProvider';
import { languageOptions, normalizePreference } from './i18n/core';

type Theme = 'light' | 'dark';
type ProjectFile = { path: string; name: string; depth: number; directory: boolean };

export function App() {
  const { t, locale } = useDisplayText();
  const { preference, setPreference } = useLanguage();
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<ProjectBinding[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const attachments = useImageAttachments(activeProjectId);
  const [modelImageInput, setModelImageInput] = useState(false);
  const sentImages = useRef(new Map<string, PromptImage[]>());
  const sentTasks = useRef(new Map<string, string>());
  const [page, setPage] = useState<'chat' | 'project' | 'capabilities'>('chat');
  const [projectDraft, setProjectDraft] = useState<{
    directory: string;
    name: string;
    domain: string;
  } | null>(null);
  const [projectError, setProjectError] = useState('');
  const [openFiles, setOpenFiles] = useState<WorkspaceFile[]>([]);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const [activeFileId, setActiveFileId] = useState('');
  const [viewState, setViewState] = useState<WorkspaceViewState>();
  const fileOpenRevision = useRef(0);
  const previewPolicy = useRef(createResultPreviewPolicy());
  const liveResultTurn = useRef<string | null>(null);
  const openResultRef = useRef<(request: ResultOpenRequest) => Promise<void>>(async () => {});
  const [layout, setLayout] = useState<'split' | 'tabs'>(() => {
    try {
      return localStorage.getItem('ia-layout-v1') === 'tabs' ? 'tabs' : 'split';
    } catch {
      return 'split';
    }
  });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [workbenchFocus, setWorkbenchFocus] = useState<'chat' | 'workspace'>('chat');
  const tabbed = layout === 'tabs' || windowWidth < 900;
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('ia-layout-v1', layout);
    } catch {
      /* Layout remains usable when storage is unavailable. */
    }
  }, [layout]);
  const [error, setError] = useState('');
  const [leftOpen, setLeftOpen] = useState(true);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const sidebarVisible = leftOpen && (windowWidth >= 760 || compactSidebarOpen);
  const [rightOpen, setRightOpen] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem('ia-workspace-width-v1'));
      return Number.isFinite(saved) && saved >= 360 && saved <= 10000 ? saved : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (workspaceWidth === null) localStorage.removeItem('ia-workspace-width-v1');
      else localStorage.setItem('ia-workspace-width-v1', String(workspaceWidth));
    } catch {
      /* Layout remains usable when storage is unavailable. */
    }
  }, [workspaceWidth]);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [capabilitySection, setCapabilitySection] = useState<CapabilitySection>('packs');
  const [capabilityReturn, setCapabilityReturn] = useState<'chat' | 'project'>('chat');
  const [domainManagerOpen, setDomainManagerOpen] = useState(false);
  const [coreUpdateOpen, setCoreUpdateOpen] = useState(false);
  const [domainFirstRun, setDomainFirstRun] = useState(false);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem('ia-theme') === 'dark' ? 'dark' : 'light',
  );
  const [debug, setDebug] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logTrace, setLogTrace] = useState<string>();
  const showAgentLog = useCallback((traceId?: string) => {
    setLogTrace(traceId);
    setLogOpen(true);
  }, []);
  const [task, setTask] = useState('');
  const [submittedTask, setSubmittedTask] = useState('');
  const [broker, setBroker] = useState<BrokerResult>();
  const [capabilityDetail, setCapabilityDetail] = useState<CapabilityDetail>();
  const [brokerError, setBrokerError] = useState('');
  const [setupNotice, setSetupNotice] = useState(false);
  const [agentStatus, setAgentStatus] = useState<{
    available: boolean;
    version: string;
    projectDir: string | null;
    configured: boolean;
    gui?: { enabled: boolean; install: string; version: string | null };
  }>();
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [remoteExecution, setRemoteExecution] = useState<{ projectId: string; ready: boolean }>();
  const remoteExecutionReady =
    remoteExecution?.projectId === activeProjectId && remoteExecution.ready;
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto'>('ask');
  const [approvalModeBusy, setApprovalModeBusy] = useState(false);
  const [agentOwned, setAgentOwned] = useState(false);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [chatAgent, setChatAgent] = useState<ChatSummary>();
  const [chatAgentProjectId, setChatAgentProjectId] = useState<string | null>(null);
  const [agentSelectionBusy, setAgentSelectionBusy] = useState(false);
  const agentSelectionPending = useRef(false);
  const [agentUnavailable, setAgentUnavailable] = useState(false);
  const onAgentAvailability = useCallback(
    (available: boolean) => setAgentUnavailable(!available),
    [],
  );
  useEffect(() => {
    agentSelectionPending.current = false;
    setAgentSelectionBusy(false);
    setAgentUnavailable(false);
  }, [activeProjectId]);
  const [runningSessions, setRunningSessions] = useState<SessionStatus[]>([]);
  const [navigating, setNavigating] = useState(false);
  const navigationPending = useRef(false);
  const navigationRevision = useRef(0);
  const listRevision = useRef(0);
  const historyRevision = useRef(0);
  const displayRevision = useRef(0);
  const historyReads = useRef(new Set<{ events: AgentEvent[]; overflow: boolean }>());
  const startingAgent = useRef(false);
  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = activeProjectId;
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const submitting = useRef(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const prependHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = chatScroll.current;
    if (!element) return;
    if (prependHeight.current !== null) {
      element.scrollTop += element.scrollHeight - prependHeight.current;
      prependHeight.current = null;
    } else if (followMessages.current) element.scrollTop = element.scrollHeight;
  }, [turns, page, tabbed, workbenchFocus]);
  function beginNavigation() {
    if (
      navigationPending.current ||
      submitting.current ||
      startingAgent.current ||
      agentSelectionPending.current
    )
      return false;
    navigationPending.current = true;
    navigationRevision.current++;
    setNavigating(true);
    return true;
  }
  function endNavigation() {
    navigationPending.current = false;
    setNavigating(false);
  }
  const approveAgent = useCallback(
    (id: string, decision: 'approve' | 'reject') =>
      navigationPending.current
        ? Promise.reject(Error('Wait for the chat to open.'))
        : window.viewerHost!.approveAgent(id, decision, activeChatId || undefined),
    [activeChatId],
  );
  const answerAgent = useCallback(
    (id: string, answers: Record<string, string>) =>
      navigationPending.current
        ? Promise.reject(Error('Wait for the chat to open.'))
        : window.viewerHost!.answerAgentQuestion(id, answers, activeChatId || undefined),
    [activeChatId],
  );
  async function readHistory(read: () => Promise<ChatHistory>): Promise<ChatHistory> {
    const pending = { events: [] as AgentEvent[], overflow: false };
    historyReads.current.add(pending);
    try {
      const history = await read();
      if (pending.overflow)
        return await readHistory(() => window.viewerHost!.chatHistory({ id: history.chat.id }));
      return mergeHistoryEvents(history, pending.events);
    } finally {
      historyReads.current.delete(pending);
    }
  }
  function applyHistory(history: ChatHistory) {
    displayRevision.current = history.eventRevision ?? 0;
    if (chatIdRef.current !== history.chat.id) {
      followMessages.current = true;
      prependHeight.current = null;
    }
    chatIdRef.current = history.chat.id;
    setActiveChatId(history.chat.id);
    setApprovalMode(history.chat.approvalMode);
    setChatAgent(history.chat);
    setChatAgentProjectId(projectIdRef.current);
    setTurns(history.turns);
    setHistoryBefore(history.before);
    setHasEarlier(history.hasMore);
    const last = history.turns.at(-1);
    setSubmittedTask(last?.task || '');
    setBroker(last?.broker || undefined);
    setAgentEvents(last?.events || []);
    setAgentBusy(Boolean(history.executing) || last?.status === 'running');
    setAgentOwned(Boolean(history.executing));
    setCapabilityDetail(undefined);
    attachments.clear();
    if (last && ['error', 'cancelled'].includes(last.status)) {
      const images = last.events.find(
        event => event.type === 'user-images' || event.type === 'input-images',
      );
      if (images && (images.type === 'user-images' || images.type === 'input-images'))
        attachments.restore(images.images);
      setTask(last.task);
    }
  }
  async function refreshChats(openSelected = false) {
    const projectId = projectIdRef.current;
    const navigation = navigationRevision.current;
    const request = openSelected ? ++historyRevision.current : ++listRevision.current;
    const list = await window.viewerHost!.chats();
    if (
      projectId !== projectIdRef.current ||
      navigation !== navigationRevision.current ||
      request !== (openSelected ? historyRevision.current : listRevision.current)
    )
      return;
    setChatList(list.chats);
    setRunningSessions(list.sessions);
    const selectedSession = list.sessions.find(session => session.chatId === chatIdRef.current);
    const selectedChat = list.chats.find(chat => chat.id === chatIdRef.current);
    setAgentBusy(Boolean(selectedSession?.running || selectedChat?.running));
    setAgentOwned(Boolean(selectedSession));
    if (selectedChat) {
      setApprovalMode(selectedChat.approvalMode);
      setChatAgent(selectedChat);
      setChatAgentProjectId(projectId);
    }
    if (openSelected && list.activeId) {
      const selectedChatId = chatIdRef.current;
      const history = await readHistory(() =>
        window.viewerHost!.chatHistory({ id: list.activeId! }),
      );
      if (
        projectId === projectIdRef.current &&
        selectedChatId === chatIdRef.current &&
        navigation === navigationRevision.current &&
        request === historyRevision.current
      )
        applyHistory(history);
    } else if (openSelected) {
      chatIdRef.current = null;
      setActiveChatId(null);
      setChatAgent(undefined);
      setChatAgentProjectId(null);
      setApprovalMode('ask');
      setTurns([]);
      setHasEarlier(false);
    }
  }
  async function openChat(id: string) {
    if (!beginNavigation()) return;
    previewPolicy.current.invalidate();
    fileOpenRevision.current++;
    try {
      const history = await readHistory(() => window.viewerHost!.selectChat(id));
      setTask('');
      applyHistory(history);
      showPage('chat');
      setBrokerError('');
    } catch (reason) {
      setError(String(reason));
    } finally {
      endNavigation();
    }
  }
  async function deleteChat(id: string) {
    if (!beginNavigation()) return;
    try {
      const list = await window.viewerHost!.deleteChat(id);
      setChatList(list.chats);
      if (id === chatIdRef.current) {
        chatIdRef.current = null;
        setActiveChatId(null);
        setTurns([]);
        setHasEarlier(false);
        setSubmittedTask('');
        setBroker(undefined);
        setAgentEvents([]);
        setTask('');
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      endNavigation();
    }
  }
  async function loadEarlier() {
    if (!activeChatId || !historyBefore || historyLoading) return;
    setHistoryLoading(true);
    const chatId = activeChatId;
    try {
      const history = await window.viewerHost!.chatHistory({ id: chatId, before: historyBefore });
      if (chatId !== chatIdRef.current) return;
      prependHeight.current = chatScroll.current?.scrollHeight || null;
      setTurns(current => [...history.turns, ...current]);
      setHistoryBefore(history.before);
      setHasEarlier(history.hasMore);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setHistoryLoading(false);
    }
  }
  useEffect(() => {
    if (!agentBusy || agentOwned) return;
    const timer = window.setInterval(() => {
      void refreshChats(true).catch(reason => setError(String(reason)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [agentBusy, agentOwned, activeChatId]);

  useEffect(() => {
    localStorage.setItem('ia-theme', theme);
  }, [theme]);
  useEffect(() => {
    const changed = () =>
      setViewerFullscreen(
        Boolean(workspace.current && document.fullscreenElement === workspace.current),
      );
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === workspace.current) {
        void document
          .exitFullscreen()
          .catch(() =>
            setFullscreenError('Use the exit fullscreen button to restore the workspace.'),
          );
      }
    };
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  async function toggleViewerFullscreen() {
    setFullscreenError('');
    try {
      if (document.fullscreenElement === workspace.current) await document.exitFullscreen();
      else await workspace.current?.requestFullscreen();
    } catch {
      setFullscreenError('Unable to enter fullscreen. Please try again.');
    }
  }
  useEffect(() => {
    if (!window.viewerHost) {
      setError('Open the Electron desktop app to inspect local files.');
      return;
    }
    void window.viewerHost
      .modelGet()
      .then(profile => setModelImageInput(profile.imageInput))
      .catch(reason => setError(String(reason)));
    void window.viewerHost
      .domains()
      .then(setDomains)
      .catch(reason => setError(String(reason)));
    void window.viewerHost
      .domainStatus()
      .then(status => {
        if (
          status.managed &&
          !status.installed.length &&
          localStorage.getItem('ia-domain-onboarding-skipped') !== 'true'
        ) {
          setDomainFirstRun(true);
          setDomainManagerOpen(true);
        }
      })
      .catch(reason => setError(String(reason)));
    void Promise.all([window.viewerHost.agentStatus(), window.viewerHost.projectBindings()])
      .then(([status, bindings]) => {
        setAgentStatus(status);
        setProjects(bindings.projects);
        setActiveProjectId(bindings.activeId);
        projectIdRef.current = bindings.activeId;
        if (bindings.projects.find(item => item.id === bindings.activeId && !item.domain))
          showPage('project');
        if (status.projectDir)
          void window
            .viewerHost!.projectFiles()
            .then(setProjectFiles)
            .catch(reason => setError(String(reason)));
        if (bindings.projects.find(item => item.id === bindings.activeId)?.domain)
          void refreshChats(true).catch(reason => setError(String(reason)));
      })
      .catch(reason => setError(String(reason)));
    let pendingEvents: AgentEvent[] = [];
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    let fileReadRevision = 0;
    let disposed = false;
    function refreshProjectFiles() {
      const projectId = projectIdRef.current;
      const revision = ++fileReadRevision;
      void window
        .viewerHost!.projectFiles()
        .then(files => {
          if (!disposed && revision === fileReadRevision && projectId === projectIdRef.current)
            setProjectFiles(files);
        })
        .catch(reason => {
          if (!disposed && projectId === projectIdRef.current) setError(String(reason));
        });
    }
    function flushEvents() {
      clearTimeout(eventTimer);
      eventTimer = undefined;
      const batch = pendingEvents.filter(
        event =>
          (!event.chatId || event.chatId === chatIdRef.current) &&
          (event.eventRevision === undefined || event.eventRevision > displayRevision.current),
      );
      pendingEvents = [];
      if (!batch.length) return;
      displayRevision.current = Math.max(
        displayRevision.current,
        ...batch.map(event => event.eventRevision ?? 0),
      );
      setAgentEvents(current => appendDisplayEvents(current, batch));
      setTurns(current =>
        current.map((turn, index) => {
          const events = batch.filter(event =>
            event.turnId ? event.turnId === turn.id : index === current.length - 1,
          );
          if (!events.length) return turn;
          let status = turn.status;
          for (const event of events) {
            if (event.type === 'done') status = event.result.status;
            else if (event.type === 'error') status = 'error';
          }
          return { ...turn, events: appendDisplayEvents(turn.events, events), status };
        }),
      );
    }
    const removeEvents = window.viewerHost.onAgentEvent(event => {
      for (const pending of historyReads.current) {
        if (pending.overflow) continue;
        if (pending.events.length >= 4096) {
          pending.events = [];
          pending.overflow = true;
        } else pending.events.push(event);
      }
      const chatId = event.chatId || '';
      const images = sentImages.current.get(chatId) || [];
      const prompt = sentTasks.current.get(chatId) || '';
      if (event.type === 'done' || event.type === 'error') {
        sentImages.current.delete(chatId);
        sentTasks.current.delete(chatId);
      }
      if (event.chatId && event.chatId !== chatIdRef.current) return;
      if (event.type === 'results-ready') {
        const candidate = previewPolicy.current.consume(event, {
          chatId: chatIdRef.current,
          projectId: projectIdRef.current,
          focusRevision: fileOpenRevision.current,
          turnId: liveResultTurn.current,
        });
        if (candidate)
          void openResultRef
            .current({ ...candidate, chatId, previewOnly: true })
            .catch(reason => setError(String(reason)));
      }
      if (
        event.type === 'results-changed' ||
        event.type === 'industrial-result' ||
        event.type === 'done'
      )
        refreshProjectFiles();
      setAgentOwned(true);
      pendingEvents.push(event);
      if (['done', 'error', 'approval', 'question'].includes(event.type)) flushEvents();
      else if (!eventTimer) eventTimer = setTimeout(flushEvents, 16);
      if (event.type === 'tool-result')
        void window
          .viewerHost!.brokerTrace()
          .then(trace => {
            if (chatId === chatIdRef.current)
              setBroker(current => (current ? { ...current, trace } : current));
          })
          .catch(reason => {
            if (chatId === chatIdRef.current) setBrokerError(String(reason));
          });
      if (event.type === 'background-state' && event.running) setAgentBusy(true);
      if (event.type === 'done' || event.type === 'error')
        void refreshChats().catch(reason => setError(String(reason)));
      if (
        event.type === 'error' ||
        (event.type === 'done' && event.result.status === 'cancelled')
      ) {
        attachments.restore(images);
        setTask(prompt);
      }
    });
    const removeUpdated = window.viewerHost.onChatUpdated(() => {
      void refreshChats().catch(reason => setError(String(reason)));
    });
    const refreshAgentStatus = () => {
      void window
        .viewerHost!.agentStatus()
        .then(status => {
          if (!disposed) setAgentStatus(status);
        })
        .catch(reason => setError(String(reason)));
    };
    const refreshModelProfile = () => {
      void window
        .viewerHost!.modelGet()
        .then(profile => {
          if (!disposed) setModelImageInput(profile.imageInput);
        })
        .catch(reason => setError(String(reason)));
    };
    const applyProjectBindings = () => {
      void window
        .viewerHost!.projectBindings()
        .then(bindings => {
          if (disposed) return;
          if (bindings.activeId !== projectIdRef.current)
            // An external switch must run the full adoption flow — workspace
            // reset, file-list refresh, chat reload — not just relabel rows;
            // otherwise the file tree and viewers keep the previous project.
            void adoptProjectBindings(bindings);
          else setProjects(bindings.projects);
        })
        .catch(reason => setError(String(reason)));
    };
    // Model and project state can change outside this window's own UI flows
    // (external IPC senders, direct config-file edits). Broadcasts invalidate
    // the mount-time snapshots; a focus re-pull additionally covers mutations
    // that bypass IPC entirely, since sending a task requires focusing first.
    const removeModelChanged = window.viewerHost.onModelChanged(() => {
      refreshAgentStatus();
      refreshModelProfile();
    });
    const removeProjectsChanged = window.viewerHost.onProjectsChanged(applyProjectBindings);
    const refreshOnWindowFocus = () => {
      refreshAgentStatus();
      applyProjectBindings();
    };
    window.addEventListener('focus', refreshOnWindowFocus);
    return () => {
      disposed = true;
      clearTimeout(eventTimer);
      removeEvents();
      removeUpdated();
      removeModelChanged();
      removeProjectsChanged();
      window.removeEventListener('focus', refreshOnWindowFocus);
    };
  }, []);
  const activeFile = openFiles.find(file => file.id === activeFileId);
  const selectedArtifact = activeFile?.artifact;
  const selectedProjectFile = activeFile?.path || '';
  const activeViewState = viewState?.id === activeFileId ? viewState : undefined;
  const activeViewer = activeViewState?.opened;
  const isViewerReady = Boolean(activeViewState?.ready);
  const viewNavigation = activeViewState?.navigation;
  const activeProject = projects.find(item => item.id === activeProjectId);
  const projectName = activeProject?.name || t('No project selected');
  const fixedDomain = activeProject?.domain || null;
  const selectedDomain = fixedDomain;
  const domainFor = (id?: string | null) => domains.find(item => item.id === id);
  const activeFileName = activeFile?.name;
  const todo = latestEvent(agentEvents, 'todo');
  const visibleProjectFiles = useMemo(() => {
    const hidden = [...collapsedDirs];
    return projectFiles.filter(item => {
      const relative = item.path.replaceAll('\\', '/');
      return !hidden.some(directory => relative.startsWith(`${directory}/`));
    });
  }, [projectFiles, collapsedDirs]);
  const runningByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of runningSessions)
      if (session.running) counts.set(session.projectId, (counts.get(session.projectId) || 0) + 1);
    return counts;
  }, [runningSessions]);
  function toggleDirectory(relative: string) {
    const key = relative.replaceAll('\\', '/');
    setCollapsedDirs(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function resetWorkspace() {
    fileOpenRevision.current++;
    setOpenFiles([]);
    setActiveFileId('');
    setViewState(undefined);
    setWorkbenchFocus('chat');
  }
  function showPage(next: 'chat' | 'project') {
    setPage(next);
    setWorkbenchFocus('chat');
    setCompactSidebarOpen(false);
  }
  function showCapabilities(section: CapabilitySection) {
    setCapabilityReturn(page === 'project' ? 'project' : 'chat');
    setCapabilitySection(section);
    setPage('capabilities');
    setWorkbenchFocus('chat');
    setCompactSidebarOpen(false);
  }
  function browseFiles() {
    setRightOpen(true);
    setFileTreeOpen(true);
    setWorkbenchFocus('workspace');
  }
  function closeFile(id: string) {
    fileOpenRevision.current++;
    const remaining = openFiles.filter(file => file.id !== id);
    setOpenFiles(remaining);
    if (id === activeFileId) {
      const index = openFiles.findIndex(file => file.id === id);
      setActiveFileId(remaining[Math.min(index, remaining.length - 1)]?.id || '');
      if (!remaining.length) {
        if (document.fullscreenElement === workspace.current) void toggleViewerFullscreen();
        setWorkbenchFocus('chat');
      }
    }
  }
  function pinFile(id: string) {
    setOpenFiles(current =>
      current.map(file => (file.id === id ? { ...file, preview: false } : file)),
    );
  }
  function selectTab(id: string) {
    fileOpenRevision.current++;
    if (id === 'chat') setWorkbenchFocus('chat');
    else {
      if (id !== 'workspace') setActiveFileId(id);
      setRightOpen(true);
      setWorkbenchFocus('workspace');
    }
  }
  function toggleLayout() {
    setLayout(tabbed ? 'split' : 'tabs');
  }
  function chooseProject() {
    setProjectError('');
    setProjectDraft({ directory: '', name: '', domain: '' });
  }
  async function chooseProjectDirectory() {
    setProjectError('');
    try {
      const directory = await window.viewerHost!.chooseProjectDirectory(locale);
      if (!directory) return;
      const existing = projects.find(item => item.path === directory);
      if (existing) {
        setProjectDraft(null);
        await selectProject(existing.id);
        return;
      }
      setProjectDraft(current =>
        current
          ? {
              ...current,
              directory,
              name: current.name || directory.split(/[\\/]/).at(-1) || 'New project',
            }
          : current,
      );
    } catch (reason) {
      setProjectError(String(reason));
    }
  }
  // Full renderer-side adoption of new project bindings: refresh the file
  // list and clear the workspace so no trace of the previous project remains.
  // Shared by the UI switch flows and the external-change sync paths.
  async function adoptProjectBindings(bindings: {
    projects: ProjectBinding[];
    activeId: string | null;
    projectDir: string | null;
  }) {
    fileOpenRevision.current++;
    setProjects(bindings.projects);
    setActiveProjectId(bindings.activeId);
    projectIdRef.current = bindings.activeId;
    setAgentStatus(current =>
      current ? { ...current, projectDir: bindings.projectDir } : current,
    );
    setProjectFiles(await window.viewerHost!.projectFiles());
    setCollapsedDirs(new Set());
    resetWorkspace();
    setRightOpen(false);
    setFileTreeOpen(false);
    setSubmittedTask('');
    setBroker(undefined);
    setCapabilityDetail(undefined);
    setAgentEvents([]);
    await refreshChats(true);
  }
  async function createProject(request: { directory: string; name: string; domain: string }) {
    if (!beginNavigation()) return;
    try {
      const bindings = await window.viewerHost!.createProject(request);
      await adoptProjectBindings(bindings);
      setProjectDraft(null);
      showPage('project');
    } catch (reason) {
      setProjectError(String(reason));
    } finally {
      endNavigation();
    }
  }
  async function selectProject(id: string) {
    if (!beginNavigation()) return;
    if (id === activeProjectId) {
      showPage('project');
      endNavigation();
      return;
    }
    setError('');
    try {
      await adoptProjectBindings(await window.viewerHost!.selectProject(id));
      showPage('project');
    } catch (reason) {
      setError(String(reason));
    } finally {
      endNavigation();
    }
  }
  async function selectProjectFile(relative: string, pin = false) {
    const project = projectIdRef.current;
    const revision = ++fileOpenRevision.current;
    setError('');
    setRightOpen(true);
    setWorkbenchFocus('workspace');
    try {
      const file = await window.viewerHost!.readProjectFile(relative);
      if (project !== projectIdRef.current || revision !== fileOpenRevision.current) return;
      const artifact = file.viewer ? await window.viewerHost!.openProjectFile(relative) : undefined;
      if (project !== projectIdRef.current || revision !== fileOpenRevision.current) return;
      const next: WorkspaceFile = {
        id: artifact ? artifact.id : `source-${relative}`,
        path: relative,
        name: file.name,
        artifact,
        source: artifact ? undefined : file,
      };
      const failed =
        viewState?.error &&
        openFilesRef.current.find(file => file.path === relative)?.id === viewState.id;
      const opened = openWorkspaceFile(openFilesRef.current, next, pin, Boolean(failed));
      setOpenFiles(opened.files);
      setActiveFileId(opened.selected.id);
    } catch (reason) {
      if (project === projectIdRef.current && revision === fileOpenRevision.current)
        setError(String(reason));
    }
  }
  const openTaskResult = useCallback(async (request: ResultOpenRequest) => {
    const project = projectIdRef.current;
    const chat = chatIdRef.current;
    const revision = ++fileOpenRevision.current;
    if (request.chatId !== chat) throw Error('Open the chat containing this result.');
    if (request.revealOnly) {
      await window.viewerHost!.revealResult(request);
      return;
    }
    const opened = await window.viewerHost!.openResult(request);
    if (
      project !== projectIdRef.current ||
      chat !== chatIdRef.current ||
      revision !== fileOpenRevision.current
    )
      return;
    const next: WorkspaceFile = {
      id: opened.artifact?.id || `result-${request.artifactId}`,
      path: opened.path,
      name: opened.name,
      artifact: opened.artifact,
      source: opened.source,
    };
    const files = openWorkspaceFile(openFilesRef.current, next, true, false);
    setOpenFiles(files.files);
    setActiveFileId(files.selected.id);
    setRightOpen(true);
    setWorkbenchFocus('workspace');
  }, []);
  openResultRef.current = openTaskResult;
  async function newChat() {
    previewPolicy.current.invalidate();
    fileOpenRevision.current++;
    if (!beginNavigation()) return;
    try {
      if (activeProject && !activeProject.domain) {
        showPage('project');
        return;
      }
      const history = await readHistory(() => window.viewerHost!.newChat());
      if (history.chat.id !== chatIdRef.current) {
        applyHistory(history);
        setTask('');
        setSubmittedTask('');
        setBroker(undefined);
        setCapabilityDetail(undefined);
        setBrokerError('');
        setAgentEvents([]);
      }
      await refreshChats();
      showPage('chat');
    } catch (reason) {
      setBrokerError(String(reason));
    } finally {
      endNavigation();
    }
  }
  async function changeChatApprovalMode(mode: 'ask' | 'auto') {
    const chatId = chatIdRef.current;
    const projectId = projectIdRef.current;
    if (!chatId || !projectId || agentBusy || navigating || approvalModeBusy) return;
    setApprovalModeBusy(true);
    try {
      const saved = await window.viewerHost!.setChatApprovalMode({ projectId, chatId, mode });
      if (chatId === chatIdRef.current && projectId === projectIdRef.current)
        setApprovalMode(saved);
    } catch (reason) {
      if (chatId === chatIdRef.current && projectId === projectIdRef.current)
        setBrokerError(String(reason));
    } finally {
      setApprovalModeBusy(false);
    }
  }
  async function resolveTask(context?: { domain: string; stage: string }, prompt = task) {
    if (
      navigationPending.current ||
      submitting.current ||
      startingAgent.current ||
      agentSelectionPending.current ||
      agentUnavailable ||
      agentBusy ||
      (activeProject?.executionLocation === 'remote' && !remoteExecutionReady) ||
      attachments.loading ||
      (!prompt.trim() && !attachments.images.length)
    )
      return;
    if (attachments.images.length && !modelImageInput) {
      setBrokerError('Choose a vision model and enable Image input in Model API settings.');
      return;
    }
    if (!agentStatus?.available || !agentStatus.configured) {
      if (agentStatus?.available) {
        setSetupNotice(true);
        return;
      }
      setBrokerError(
        'Kimi is unavailable. Check its installation in Settings before running this task.',
      );
      return;
    }
    prompt = prompt.trim() || 'Describe the attached images.';
    const images = [...attachments.images];
    submitting.current = true;
    followMessages.current = true;
    setAgentBusy(true);
    setBrokerError('');
    setCapabilityDetail(undefined);
    try {
      const artifactKind = /\b(this|selected|current)\b|这个|当前|该|它/i.test(prompt)
        ? selectedArtifact?.kind
        : undefined;
      const result = await window.viewerHost!.resolve({
        task: prompt,
        chatId: chatIdRef.current || undefined,
        artifactKind,
        domain: selectedDomain || context?.domain,
        stage: context?.domain === selectedDomain || !selectedDomain ? context?.stage : undefined,
      });
      setBroker(result);
      liveResultTurn.current = result.turnId || null;
      await refreshChats(true);
      setTask('');
      if (agentStatus?.available && agentStatus.configured && agentStatus.projectDir)
        await runAgent(prompt, images);
      else setAgentBusy(false);
    } catch (reason) {
      setBrokerError(String(reason));
      setAgentBusy(false);
    } finally {
      submitting.current = false;
    }
  }
  async function setProjectDomain(id: string, domain: string) {
    try {
      const bindings = await window.viewerHost!.setProjectDomain(id, domain);
      if (activeProject?.domain !== domain) resetWorkspace();
      setProjects(bindings.projects);
      setTask('');
      setSubmittedTask('');
      setBroker(undefined);
      setCapabilityDetail(undefined);
      setBrokerError('');
      setAgentEvents([]);
      await refreshChats(true);
    } catch (reason) {
      throw reason;
    }
  }
  function resourcesChanged() {
    setBroker(undefined);
    setCapabilityDetail(undefined);
    setBrokerError('');
    void window
      .viewerHost!.projectBindings()
      .then(bindings => setProjects(bindings.projects))
      .catch(reason => setError(String(reason)));
  }
  async function showDetail(id: string) {
    try {
      setCapabilityDetail(await window.viewerHost!.detail(id));
      const trace = await window.viewerHost!.brokerTrace();
      setBroker(current => (current ? { ...current, trace } : current));
    } catch (reason) {
      setBrokerError(String(reason));
    }
  }
  async function runAgent(prompt = submittedTask, images: PromptImage[] = []) {
    if (
      navigationPending.current ||
      startingAgent.current ||
      agentSelectionPending.current ||
      agentUnavailable
    )
      return;
    startingAgent.current = true;
    previewPolicy.current.begin({
      chatId: chatIdRef.current,
      projectId: projectIdRef.current,
      focusRevision: fileOpenRevision.current,
    });
    const chatId = chatIdRef.current;
    if (chatId) {
      sentImages.current.set(chatId, images);
      sentTasks.current.set(chatId, prompt);
    }
    attachments.clear();
    setAgentEvents([]);
    setAgentBusy(true);
    try {
      await window.viewerHost!.runAgent({
        task: prompt,
        chatId: chatId || undefined,
        projectId: activeProjectId!,
        images,
      });
      await refreshChats(true);
    } catch (reason) {
      attachments.restore(images);
      setTask(prompt);
      setBrokerError(String(reason));
      setAgentBusy(false);
    } finally {
      startingAgent.current = false;
    }
  }

  const diagnostic = latestEvent(agentEvents, 'diagnostic-log');
  return (
    <div
      className={`rp-shell ia-app theme-${theme} ${sidebarVisible ? '' : 'left-collapsed'} ${rightOpen ? '' : 'right-collapsed'} ${tabbed ? 'layout-tabs' : 'layout-split'}`}
      data-platform={window.viewerHost?.platform}
    >
      <div className="ia-columns">
        {sidebarVisible && (
          <aside className="ia-tree ia-sidebar" aria-label={t('Project navigation')}>
            <div className="ia-sidebar-brand">
              <span className="ia-product-mark">
                <img src="./product-mark.png" width={28} height={28} alt="" />
              </span>
              <b>Industrial Harness</b>
              <button
                className="ia-icon"
                onClick={() => {
                  setLeftOpen(false);
                  setCompactSidebarOpen(false);
                }}
                title={t('Hide sidebar')}
                aria-label={t('Hide sidebar')}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <div className="ia-projects-heading">
              <span>{t('PROJECTS')}</span>
              <button
                onClick={chooseProject}
                disabled={navigating || submitting.current}
                aria-label={t('New project')}
                title={t('New project')}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="ia-project-list">
              {projects.map(item => {
                const domain = domainFor(item.domain);
                const active = item.id === activeProjectId;
                return (
                  <div key={item.id} className="ia-project-group">
                    <button
                      className={`ia-project-row ${active ? 'selected' : ''}`}
                      onClick={() => void selectProject(item.id)}
                      title={item.path}
                      aria-current={active && page === 'project' ? 'page' : undefined}
                      disabled={navigating || submitting.current}
                    >
                      <FolderOpen size={15} />
                      <span className="ia-project-row-name">{item.name}</span>
                      {Boolean(runningByProject.get(item.id)) && (
                        <small className="ia-project-running" title={t('Running chats')}>
                          {runningByProject.get(item.id)}
                        </small>
                      )}
                      {domain && (
                        <span className="ia-project-domain-badge" title={t(domain.label)}>
                          <DomainIcon domain={domain.id} size={14} />
                          {t(domain.label)}
                        </span>
                      )}
                    </button>
                    {active && (
                      <div
                        className="ia-project-chats"
                        role="group"
                        aria-label={t('{0} chats', { '0': item.name })}
                        data-project-id={item.id}
                      >
                        <button
                          className="ia-new-chat"
                          onClick={() => void newChat()}
                          disabled={
                            navigating ||
                            agentSelectionBusy ||
                            submitting.current ||
                            !item.domain ||
                            (page === 'chat' && Boolean(activeChatId) && turns.length === 0)
                          }
                          title={
                            page === 'chat' && activeChatId && turns.length === 0
                              ? t('Send a message in this chat before starting another')
                              : t('New chat')
                          }
                          aria-label={t('New chat in {0}', { '0': item.name })}
                        >
                          <FilePlus2 size={14} />
                          {t('New chat')}
                        </button>
                        {chatList.map(chat => (
                          <div className="ia-chat-row" key={chat.id}>
                            <button
                              className="ia-sidebar-chat"
                              title={chat.title}
                              disabled={navigating || submitting.current}
                              aria-current={
                                page === 'chat' && activeChatId === chat.id ? 'page' : undefined
                              }
                              onClick={() => void openChat(chat.id)}
                            >
                              <Activity size={14} />
                              <span>{chat.title}</span>
                              {chat.running && (
                                <small
                                  className={`ia-session-running ${chat.awaitingApproval || chat.awaitingQuestion ? 'awaiting-approval' : ''}`}
                                  role="status"
                                  aria-label={
                                    chat.awaitingQuestion
                                      ? t('Awaiting answer')
                                      : chat.awaitingApproval
                                        ? t('Awaiting approval')
                                        : t('Running')
                                  }
                                  title={
                                    chat.awaitingQuestion
                                      ? t('Awaiting answer')
                                      : chat.awaitingApproval
                                        ? t('Awaiting approval')
                                        : t('Running')
                                  }
                                />
                              )}
                            </button>
                            <button
                              className="ia-chat-delete"
                              aria-label={t('Delete chat {0}', { '0': chat.title })}
                              title={t('Delete chat')}
                              disabled={chat.running || navigating || submitting.current}
                              onClick={() => void deleteChat(chat.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {error && <p className="ia-sidebar-error">{t(error)}</p>}
            <div className="ia-sidebar-spacer" />
            <div className="ia-tree-bottom">
              <button
                className="ia-settings-button"
                onClick={() => setSettingsOpen(value => !value)}
                aria-expanded={settingsOpen}
              >
                <Settings2 size={16} />
                {t('Settings')} <ChevronRight size={14} />
              </button>
            </div>
            {settingsOpen && (
              <div className="ia-settings-popover">
                <div className="ia-settings-title">
                  <b>{t('Settings')}</b>
                  <button
                    className="ia-icon"
                    onClick={() => setSettingsOpen(false)}
                    aria-label={t('Close settings')}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="ia-settings-row">
                  <label htmlFor="ia-language">{t('Language')}</label>
                  <select
                    id="ia-language"
                    aria-label={t('Language')}
                    value={preference}
                    onChange={event => setPreference(normalizePreference(event.target.value))}
                  >
                    <option value="system">{t('Follow system')}</option>
                    {languageOptions.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ia-settings-row">
                  <span>{t('Appearance')}</span>
                  <button onClick={() => setTheme(value => (value === 'light' ? 'dark' : 'light'))}>
                    {theme === 'light' ? <Sun size={14} /> : <Moon size={14} />}{' '}
                    {theme === 'light' ? t('Light') : t('Dark')}
                  </button>
                </div>
                <div className="ia-settings-row">
                  <span>{t('Debug logs')}</span>
                  <button onClick={() => setDebug(value => !value)}>
                    <Bug size={14} /> {debug ? t('On') : t('Off')}
                  </button>
                </div>
                <ComputerUseSettings />
                <div className="ia-settings-row">
                  <span>{t('Model API')}</span>
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      setModelSettingsOpen(true);
                    }}
                  >
                    {t('Configure')}
                  </button>
                </div>
                <div className="ia-settings-row">
                  <span>{t('Agents')}</span>
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      showCapabilities('agents');
                    }}
                  >
                    {t('Configure')}
                  </button>
                </div>
                <div className="ia-settings-row">
                  <span>{t('MCP & Skills')}</span>
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      showCapabilities('mcp');
                    }}
                  >
                    {t('Configure')}
                  </button>
                </div>
                <div className="ia-settings-row">
                  <span>{t('Domains')}</span>
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      showCapabilities('packs');
                    }}
                  >
                    {t('Manage')}
                  </button>
                </div>
                <div className="ia-settings-row">
                  <span>{t('Application')}</span>
                  <button
                    onClick={() => {
                      setSettingsOpen(false);
                      setCoreUpdateOpen(true);
                    }}
                  >
                    {t('Check updates')}
                  </button>
                </div>
                <div className="ia-settings-note">
                  {t('Kimi CLI:')}{' '}
                  {agentStatus?.available
                    ? agentStatus.version || t('available')
                    : t('unavailable')}
                </div>
              </div>
            )}
          </aside>
        )}
        {sidebarVisible && windowWidth < 760 && (
          <button
            className="ia-sidebar-backdrop"
            aria-label={t('Hide sidebar')}
            onClick={() => setCompactSidebarOpen(false)}
          />
        )}
        <div className="ia-workbench">
          {tabbed && (
            <div
              className={`ia-workbench-tabbar ${!sidebarVisible && window.viewerHost?.platform === 'darwin' ? 'ia-lights-gap' : ''}`}
            >
              {!sidebarVisible && (
                <button
                  className="ia-icon"
                  title={t('Show sidebar')}
                  aria-label={t('Show sidebar')}
                  onClick={() => {
                    setLeftOpen(true);
                    setCompactSidebarOpen(true);
                  }}
                >
                  <PanelLeftOpen size={16} />
                </button>
              )}
              <WorkspaceTabs
                tabs={[
                  {
                    id: 'chat',
                    chat: true,
                    title:
                      page === 'capabilities'
                        ? t('Capability center')
                        : page === 'project'
                          ? projectName
                          : chatList.find(chat => chat.id === activeChatId)?.title || t('Chat'),
                    status: chatList.find(chat => chat.id === activeChatId)?.awaitingQuestion
                      ? t('Awaiting answer')
                      : chatList.find(chat => chat.id === activeChatId)?.awaitingApproval
                        ? t('Awaiting approval')
                        : agentBusy
                          ? t('Running')
                          : undefined,
                  },
                  ...openFiles.map(file => ({
                    id: file.id,
                    title: file.name,
                    preview: file.preview,
                  })),
                  ...(rightOpen && !openFiles.length
                    ? [{ id: 'workspace', title: t('Workspace') }]
                    : []),
                ]}
                selected={workbenchFocus === 'chat' ? 'chat' : activeFileId || 'workspace'}
                onSelect={selectTab}
                onClose={closeFile}
                onPin={pinFile}
                onAdd={browseFiles}
              />
              <button
                className="ia-layout-toggle ia-icon"
                aria-label={t('Use split layout')}
                title={
                  windowWidth < 900
                    ? t('Split layout is available in a wider window')
                    : t('Use split layout')
                }
                disabled={windowWidth < 900}
                onClick={toggleLayout}
              >
                <Columns2 size={17} />
              </button>
            </div>
          )}
          <div className="ia-workbench-content">
            <main
              id="ia-chat-panel"
              className={`ia-chat${page !== 'project' && !turns.length ? ' ia-chat-empty' : ''}`}
              hidden={tabbed && workbenchFocus !== 'chat'}
              role={tabbed ? 'tabpanel' : undefined}
              aria-labelledby={tabbed ? 'tab-chat' : undefined}
            >
              {page !== 'capabilities' && (
                <header className="ia-chat-header">
                  <div>
                    {!sidebarVisible && (
                      <button
                        className="ia-icon"
                        onClick={() => {
                          setLeftOpen(true);
                          setCompactSidebarOpen(true);
                        }}
                        title={t('Show sidebar')}
                        aria-label={t('Show sidebar')}
                      >
                        <PanelLeftOpen size={16} />
                      </button>
                    )}
                    <button
                      className="ia-header-project"
                      onClick={() => setPage('project')}
                      disabled={!activeProject}
                      title={activeProject?.path}
                      aria-label={t('Project details: {0}', { '0': projectName })}
                    >
                      <Folder size={16} />
                      <b>{projectName}</b>
                      {activeProject && <ChevronDown size={13} />}
                    </button>
                  </div>
                  <div className="ia-chat-actions">
                    <WindowControls />
                    {!tabbed && (
                      <button
                        className="ia-layout-toggle"
                        onClick={toggleLayout}
                        title={t('Use tab layout')}
                        aria-label={t('Use tab layout')}
                      >
                        <PanelsTopLeft size={16} />
                      </button>
                    )}
                    <button
                      className="ia-log-button"
                      aria-label={t('View agent logs')}
                      title={t('View detailed agent logs')}
                      disabled={!activeProjectId}
                      onClick={() => showAgentLog()}
                    >
                      {t('Logs')}
                    </button>
                    <button
                      className={debug ? 'active' : ''}
                      onClick={() => setDebug(value => !value)}
                      title={t('Toggle debug logs')}
                      aria-label={t('Toggle debug logs')}
                      aria-pressed={debug}
                    >
                      <Bug size={15} />
                    </button>
                    <button
                      onClick={() => {
                        setRightOpen(value => !value);
                        setWorkbenchFocus('workspace');
                      }}
                      title={rightOpen ? t('Hide workspace') : t('Show workspace')}
                      aria-label={rightOpen ? t('Hide workspace') : t('Show workspace')}
                      aria-pressed={rightOpen}
                    >
                      {rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                    </button>
                  </div>
                </header>
              )}
              {page === 'capabilities' ? (
                <CapabilityCenter
                  project={activeProject || undefined}
                  domains={domains}
                  busy={runningSessions.some(session => session.running)}
                  initialSection={capabilitySection}
                  returnPage={capabilityReturn}
                  onDomainsChanged={items => {
                    setDomains(items);
                    resourcesChanged();
                  }}
                  onResourcesChanged={() => {
                    setResourceRevision(value => value + 1);
                    resourcesChanged();
                  }}
                  onExit={() => showPage(capabilityReturn)}
                />
              ) : page === 'project' && activeProject ? (
                <ProjectDetails
                  key={activeProject.id}
                  project={activeProject}
                  domains={domains}
                  busy={runningSessions.some(
                    session => session.projectId === activeProjectId && session.running,
                  )}
                  onDomainChange={setProjectDomain}
                  resourceRevision={resourceRevision}
                  onResourcesChanged={resourcesChanged}
                  onNewChat={newChat}
                />
              ) : (
                <>
                  <div className="ia-chat-scroll-area">
                    <MessageRail turns={turns} />
                    <div
                      className="ia-chat-scroll"
                      ref={chatScroll}
                      onScroll={event => {
                        const element = event.currentTarget;
                        if (!element.getClientRects().length) return;
                        followMessages.current =
                          element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                      }}
                    >
                      {hasEarlier && (
                        <button
                          className="ia-history-more"
                          disabled={historyLoading}
                          onClick={() => void loadEarlier()}
                        >
                          {historyLoading ? t('Loading…') : t('Load earlier messages')}
                        </button>
                      )}
                      {!turns.length && (
                        <div className="ia-chat-welcome">
                          <h1>
                            {activeProject
                              ? t('What are you working on?')
                              : t('Start with your project.')}
                          </h1>
                          <p>
                            {activeProject
                              ? t(
                                  'Describe a task in your project. Relevant capabilities and tools will appear as the work progresses.',
                                )
                              : t(
                                  'Choose a local folder and a domain, then describe what you want to work on.',
                                )}
                          </p>
                        </div>
                      )}
                      {turns.map((turn, index) => (
                        <div
                          className="ia-chat-turn"
                          key={turn.id}
                          data-turn-id={turn.id}
                          data-turn-index={index}
                        >
                          <div className="ia-user-entry ia-message">
                            <div className="ia-user-message">
                              {turn.task}
                              {turn.events.map(event =>
                                event.type === 'user-images' || event.type === 'input-images' ? (
                                  <ImageThumbnails key="input-images" images={event.images} />
                                ) : null,
                              )}
                            </div>
                            <MessageActions text={turn.task} recordedAt={turn.createdAt} />
                          </div>
                          {turn.broker && (
                            <BrokerCall
                              broker={turn.broker}
                              detail={index === turns.length - 1 ? capabilityDetail : undefined}
                              debug={debug}
                              selectedDomain={selectedDomain}
                              readOnly={index !== turns.length - 1 || agentBusy}
                              onContext={context => void resolveTask(context, turn.task)}
                              onDetail={id => void showDetail(id)}
                            />
                          )}
                          {turn.events.length > 0 && (
                            <AgentFlow
                              onLog={showAgentLog}
                              onOpenResult={openTaskResult}
                              turnId={turn.id}
                              chatId={activeChatId || undefined}
                              events={turn.events}
                              running={agentOwned && agentBusy && index === turns.length - 1}
                              debug={debug}
                              approve={approveAgent}
                              answer={answerAgent}
                            />
                          )}
                        </div>
                      ))}
                      {brokerError && <div className="ia-flow-error">{t(brokerError)}</div>}
                    </div>
                  </div>
                  {setupNotice && agentStatus && !agentStatus.configured && (
                    <div className="ia-setup-banner" role="status">
                      <Settings2 size={15} />
                      <span>{t('Configure the Model API to run tasks. Your draft is kept.')}</span>
                      <button
                        onClick={() => {
                          setSetupNotice(false);
                          setModelSettingsOpen(true);
                        }}
                      >
                        {t('Open model settings')}
                      </button>
                    </div>
                  )}
                  {todo?.type === 'todo' && <TodoList items={todo.items} running={agentBusy} />}
                  {agentBusy && !agentOwned && (
                    <p role="status" className="ia-composer-hint">
                      {t(
                        'This chat is running in another window. Open a new chat to work in parallel.',
                      )}
                    </p>
                  )}
                  {activeProject?.executionLocation === 'remote' && (
                    <RemoteTaskStatus
                      key={activeProject.id}
                      projectId={activeProject.id}
                      onReady={ready => setRemoteExecution({ projectId: activeProject.id, ready })}
                      onConfigure={() => showPage('project')}
                    />
                  )}
                  <div className="ia-composer-wrap">
                    <div
                      className="ia-composer"
                      onDragOver={event => {
                        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                      }}
                      onDrop={event => {
                        if (!event.dataTransfer.files.length) return;
                        event.preventDefault();
                        if (!agentBusy)
                          void attachments.addFiles(Array.from(event.dataTransfer.files));
                      }}
                      onPaste={event => {
                        const files = Array.from(event.clipboardData.items)
                          .filter(item => item.kind === 'file')
                          .map(item => item.getAsFile())
                          .filter((file): file is File => Boolean(file));
                        if (files.length) {
                          event.preventDefault();
                          if (!agentBusy) void attachments.addFiles(files);
                        }
                      }}
                    >
                      {!turns.length && (
                        <button
                          className="ia-composer-project"
                          type="button"
                          onClick={activeProject ? () => setPage('project') : chooseProject}
                          disabled={navigating || submitting.current}
                          title={activeProject ? t('Project details') : t('New project')}
                        >
                          <Folder size={15} />
                          <span>{activeProject?.name || t('New project')}</span>
                          <ChevronDown size={13} />
                        </button>
                      )}
                      <div className="ia-composer-body">
                        <ImageThumbnails
                          images={attachments.images}
                          onRemove={attachments.remove}
                          disabled={agentBusy || attachments.loading}
                        />
                        {attachments.error && (
                          <p role="alert" className="ia-flow-error">
                            {t(attachments.error)}
                          </p>
                        )}
                        {attachments.loading && <p role="status">{t('Preparing images…')}</p>}
                        {attachments.images.length > 0 && !modelImageInput && (
                          <p className="ia-image-model-hint">
                            {t('This model is configured for text only.')}{' '}
                            <button onClick={() => setModelSettingsOpen(true)}>
                              {t('Configure image input')}
                            </button>
                          </p>
                        )}
                        <textarea
                          aria-label={t('Engineering task')}
                          aria-describedby="ia-composer-help"
                          placeholder={
                            activeProject
                              ? t('Ask about your project…')
                              : t('Create or choose a project to start…')
                          }
                          value={task}
                          disabled={
                            agentBusy ||
                            agentSelectionBusy ||
                            navigating ||
                            !fixedDomain ||
                            (activeProject?.executionLocation === 'remote' && !remoteExecutionReady)
                          }
                          onChange={event => setTask(event.target.value)}
                          onKeyDown={event => {
                            if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              void resolveTask();
                            }
                          }}
                        />
                        <div className="ia-composer-footer">
                          <div className="ia-chat-controls">
                            <DomainPill
                              domain={fixedDomain}
                              domains={domains}
                              label={t('Session domain')}
                            />
                            {activeProjectId &&
                              fixedDomain &&
                              activeProject?.executionLocation !== 'remote' && (
                                <ChatAgentSelect
                                  key={`${activeProjectId}:${fixedDomain}:${activeChatId || 'draft'}`}
                                  projectId={activeProjectId}
                                  chat={
                                    chatAgentProjectId === activeProjectId &&
                                    chatAgent?.domain === fixedDomain &&
                                    chatAgent?.id === activeChatId
                                      ? {
                                          ...chatAgent,
                                          agentLocked: chatAgent.agentLocked || turns.length > 0,
                                        }
                                      : undefined
                                  }
                                  busy={
                                    agentBusy ||
                                    navigating ||
                                    submitting.current ||
                                    agentSelectionBusy ||
                                    Boolean(activeChatId && chatAgentProjectId !== activeProjectId)
                                  }
                                  revision={resourceRevision}
                                  onAvailabilityChange={onAgentAvailability}
                                  onCreate={async agentId => {
                                    const projectId = projectIdRef.current;
                                    const draftImages = [...attachments.images];
                                    const draftText = task;
                                    const history = await readHistory(() =>
                                      window.viewerHost!.newChat({ agentId }),
                                    );
                                    if (projectId !== projectIdRef.current)
                                      throw Error('Open the project before choosing an agent.');
                                    applyHistory(history);
                                    attachments.restore(draftImages);
                                    setTask(draftText);
                                    await refreshChats();
                                    return history.chat;
                                  }}
                                  onSavingChange={value => {
                                    if (activeProjectId !== projectIdRef.current) return;
                                    agentSelectionPending.current = value;
                                    setAgentSelectionBusy(value);
                                  }}
                                  onChanged={next => {
                                    if (
                                      next.id !== chatIdRef.current ||
                                      activeProjectId !== projectIdRef.current
                                    )
                                      return;
                                    setChatAgent(next);
                                    setChatAgentProjectId(activeProjectId);
                                    setChatList(current =>
                                      current.map(item => (item.id === next.id ? next : item)),
                                    );
                                  }}
                                />
                              )}
                            <select
                              className="ia-chat-approval-mode"
                              aria-label={t('Approval mode for this chat')}
                              title={
                                approvalMode === 'auto'
                                  ? t(
                                      'Tools are automatically approved in this chat only. Questions still wait for your answer.',
                                    )
                                  : t(
                                      'Ask before actions in this chat. New chats use this mode by default.',
                                    )
                              }
                              value={approvalMode}
                              disabled={
                                !activeChatId ||
                                agentBusy ||
                                agentSelectionBusy ||
                                navigating ||
                                approvalModeBusy
                              }
                              onChange={event =>
                                void changeChatApprovalMode(event.target.value as 'ask' | 'auto')
                              }
                            >
                              <option value="ask">{t('Request approval')}</option>
                              <option value="auto">{t('Auto approve')}</option>
                            </select>
                          </div>
                          <div className="ia-send-actions">
                            <ImageAttachButton
                              attachments={attachments}
                              disabled={agentBusy || attachments.loading || !activeProjectId}
                            />
                            {agentOwned && agentBusy && (
                              <button
                                disabled={navigating}
                                onClick={() => {
                                  if (navigationPending.current) return;
                                  void window
                                    .viewerHost!.interruptAgent(activeChatId || undefined)
                                    .catch(reason => setBrokerError(String(reason)));
                                }}
                                title={t('Stop agent')}
                                aria-label={t('Stop agent')}
                              >
                                <Square size={14} />
                              </button>
                            )}
                            {Boolean(
                              broker &&
                                agentStatus?.available &&
                                agentStatus.configured &&
                                agentStatus.projectDir,
                            ) && (
                              <button
                                onClick={() => void runAgent()}
                                disabled={
                                  navigating ||
                                  agentSelectionBusy ||
                                  agentUnavailable ||
                                  agentBusy ||
                                  submitting.current ||
                                  turns.at(-1)?.status !== 'scoped'
                                }
                                title={t('Run with Kimi')}
                                aria-label={t('Run with Kimi')}
                              >
                                <Play size={14} />
                              </button>
                            )}
                            <button
                              className="ia-send"
                              onClick={() => void resolveTask()}
                              disabled={
                                navigating ||
                                agentSelectionBusy ||
                                agentUnavailable ||
                                agentBusy ||
                                !fixedDomain ||
                                (activeProject?.executionLocation === 'remote' &&
                                  !remoteExecutionReady) ||
                                attachments.loading ||
                                (!task.trim() && !attachments.images.length) ||
                                (attachments.images.length > 0 && !modelImageInput)
                              }
                              title={t('Send task')}
                              aria-label={t('Send task')}
                            >
                              <ArrowUp size={18} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p id="ia-composer-help" className="ia-sr-only">
                      {t('Press Enter to send. Press Shift+Enter for a new line.')}
                    </p>
                    <div className="ia-composer-hint">
                      <span role="status">
                        {!activeProject
                          ? t('Choose a project to run Kimi')
                          : !agentStatus?.available
                            ? t('Kimi CLI is required to run Agent tasks')
                            : !agentStatus.configured
                              ? t('Configure the Model API in Settings to run Kimi')
                              : !agentStatus.projectDir
                                ? t('Choose a project to run Kimi')
                                : t('Kimi ready')}
                      </span>
                      <span className="ia-composer-shortcuts" aria-hidden="true">
                        <kbd>Enter</kbd> {t('Send')}
                        <span>·</span>
                        <kbd>Shift Enter</kbd> {t('New line')}
                      </span>
                    </div>
                    {!turns.length && (
                      <div className="ia-welcome-actions">
                        {activeProject ? (
                          <>
                            <button onClick={() => setPage('project')}>
                              <Settings2 size={15} />
                              {t('Project details')}
                            </button>
                            <button onClick={browseFiles}>
                              <FolderOpen size={15} />
                              {t('Browse project files')}
                            </button>
                          </>
                        ) : (
                          <button
                            className="ia-welcome-create"
                            onClick={chooseProject}
                            disabled={navigating || submitting.current}
                          >
                            <Plus size={16} />
                            {t('New project')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </main>
            {rightOpen && !tabbed && (
              <WorkspaceDivider
                workspace={workspace}
                width={workspaceWidth}
                onChange={setWorkspaceWidth}
                fullscreen={viewerFullscreen}
              />
            )}
            {(rightOpen || openFiles.length > 0) && (
              <section
                id="ia-workspace-panel"
                role={tabbed ? 'tabpanel' : undefined}
                aria-labelledby={tabbed ? `tab-${activeFileId || 'workspace'}` : undefined}
                hidden={!viewerFullscreen && (tabbed ? workbenchFocus !== 'workspace' : !rightOpen)}
                ref={workspace}
                className="ia-viewer ia-workspace"
                style={
                  tabbed || workspaceWidth === null ? undefined : { flexBasis: workspaceWidth }
                }
              >
                <header className="ia-viewer-header">
                  <div>
                    <File size={14} />
                    <b onDoubleClick={() => pinFile(activeFileId)}>
                      {activeFileName || t('Workspace')}
                    </b>
                    {!tabbed && activeFile?.preview && (
                      <button
                        className="ia-icon"
                        onClick={() => pinFile(activeFileId)}
                        title={t('Keep tab')}
                        aria-label={t('Keep tab')}
                      >
                        <Pin size={13} />
                      </button>
                    )}
                    {activeFileName && (
                      <button
                        className="ia-icon"
                        onClick={() => closeFile(activeFileId)}
                        title={t('Close file')}
                        aria-label={t('Close file')}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  <div className="ia-workspace-actions">
                    {fullscreenError && <span role="status">{t(fullscreenError)}</span>}
                    {activeViewer && (
                      <div className="ia-view-navigation" aria-label={t('Viewer zoom controls')}>
                        <button
                          aria-label={t('Zoom out')}
                          title={t('Zoom out')}
                          disabled={!isViewerReady || !viewNavigation?.ready}
                          onClick={() => viewNavigation?.zoomOut()}
                        >
                          −
                        </button>
                        <output aria-label={t('Viewer zoom')}>
                          {viewNavigation?.percent == null
                            ? t(viewNavigation?.description || 'Zoom')
                            : `${viewNavigation.percent}%`}
                        </output>
                        <button
                          aria-label={t('Zoom in')}
                          title={t('Zoom in')}
                          disabled={!isViewerReady || !viewNavigation?.ready}
                          onClick={() => viewNavigation?.zoomIn()}
                        >
                          +
                        </button>
                        <button
                          aria-label={t('Fit viewer')}
                          title={t('Fit content to the view')}
                          disabled={!isViewerReady || !viewNavigation?.ready}
                          onClick={() => viewNavigation?.fit()}
                        >
                          {t('Fit')}
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => void toggleViewerFullscreen()}
                      title={
                        viewerFullscreen ? t('Exit viewer fullscreen') : t('Fullscreen viewer')
                      }
                      aria-label={
                        viewerFullscreen ? t('Exit viewer fullscreen') : t('Fullscreen viewer')
                      }
                      aria-pressed={viewerFullscreen}
                    >
                      {viewerFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                    </button>
                    <button
                      className="ia-file-tree-toggle"
                      onClick={() => setFileTreeOpen(value => !value)}
                      title={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
                      aria-label={fileTreeOpen ? t('Hide file tree') : t('Show file tree')}
                      aria-pressed={fileTreeOpen}
                    >
                      {fileTreeOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                    </button>
                    <button
                      onClick={() => {
                        if (document.fullscreenElement === workspace.current)
                          void toggleViewerFullscreen();
                        setRightOpen(false);
                        setWorkbenchFocus('chat');
                      }}
                      title={t('Hide workspace')}
                      aria-label={t('Hide workspace')}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </header>
                {!tabbed && openFiles.length > 1 && (
                  <WorkspaceTabs
                    tabs={openFiles.map(file => ({
                      id: file.id,
                      title: file.name,
                      preview: file.preview,
                    }))}
                    selected={activeFileId}
                    onSelect={selectTab}
                    onClose={closeFile}
                    onPin={pinFile}
                    onAdd={browseFiles}
                  />
                )}
                <div className="ia-workspace-body">
                  <div className="ia-workspace-content">
                    <div className="ia-workspace-breadcrumb">
                      {selectedProjectFile || projectName}
                    </div>
                    {openFiles.map(file => (
                      <WorkspaceFileView
                        key={file.id}
                        file={file}
                        active={file.id === activeFileId}
                        onState={setViewState}
                      />
                    ))}
                    {!activeFile && (
                      <div className="ia-workspace-empty">
                        {t(error) || t('Open the file tree to browse this project.')}
                      </div>
                    )}
                    {selectedArtifact && (
                      <footer className="ia-viewer-footer">
                        {selectedArtifact.kind.toUpperCase()} ·{' '}
                        {activeViewer && isViewerReady
                          ? t('Ready')
                          : activeViewState?.error
                            ? t('Error')
                            : t('Loading')}{' '}
                        · SHA-256 {selectedArtifact.sha256.slice(0, 16)}…
                      </footer>
                    )}
                  </div>
                  {fileTreeOpen && (
                    <aside className="ia-workspace-tree">
                      <div className="ia-file-search">{t('FILES')}</div>
                      <button className="ia-file-root" onClick={() => setPage('project')}>
                        <ChevronDown size={13} />
                        <FolderOpen size={14} />
                        <span>{projectName}</span>
                      </button>
                      <div className="ia-file-list">
                        {visibleProjectFiles.map(item => (
                          <button
                            key={item.path}
                            className={selectedProjectFile === item.path ? 'selected' : ''}
                            style={{ paddingLeft: 11 + item.depth * 13 }}
                            onClick={() =>
                              item.directory
                                ? toggleDirectory(item.path)
                                : void selectProjectFile(item.path)
                            }
                            onDoubleClick={() => {
                              if (!item.directory) void selectProjectFile(item.path, true);
                            }}
                            title={item.path}
                          >
                            {item.directory ? (
                              collapsedDirs.has(item.path.replaceAll('\\', '/')) ? (
                                <ChevronRight size={12} />
                              ) : (
                                <ChevronDown size={12} />
                              )
                            ) : (
                              <File size={13} />
                            )}
                            <span>{item.name}</span>
                          </button>
                        ))}
                        {!projectFiles.length && (
                          <p className="ia-file-hint">
                            {t('Choose a project to browse its files.')}
                          </p>
                        )}
                      </div>
                    </aside>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
      {projectDraft && (
        <CreateProjectModal
          draft={projectDraft}
          domains={domains}
          error={projectError}
          onChange={setProjectDraft}
          onChooseDirectory={chooseProjectDirectory}
          onClose={() => setProjectDraft(null)}
          onCreate={createProject}
        />
      )}
      {logOpen && activeProjectId && (
        <AgentLogPanel
          key={activeProjectId}
          projectId={activeProjectId}
          projectName={projectName}
          initialTraceId={logTrace}
          runningTraceId={diagnostic?.type === 'diagnostic-log' ? diagnostic.traceId : undefined}
          running={agentBusy}
          onClose={() => setLogOpen(false)}
        />
      )}
      {domainManagerOpen && (
        <DomainManager
          firstRun={domainFirstRun}
          onSetupNext={action => {
            localStorage.setItem('ia-domain-onboarding-skipped', 'true');
            setDomainManagerOpen(false);
            setDomainFirstRun(false);
            if (action === 'model') setModelSettingsOpen(true);
            else setProjectDraft({ directory: '', name: '', domain: domains[0]?.id || '' });
          }}
          busy={runningSessions.some(session => session.running)}
          onChanged={items => {
            setDomains(items);
            resourcesChanged();
          }}
          onClose={() => {
            if (domainFirstRun) localStorage.setItem('ia-domain-onboarding-skipped', 'true');
            setDomainManagerOpen(false);
            setDomainFirstRun(false);
          }}
        />
      )}
      {coreUpdateOpen && (
        <CoreUpdatePanel
          busy={runningSessions.some(session => session.running)}
          onClose={() => setCoreUpdateOpen(false)}
        />
      )}
      {modelSettingsOpen && (
        <ModelSettings
          onClose={() => setModelSettingsOpen(false)}
          onSaved={profile => {
            setModelImageInput(profile.imageInput);
            void window.viewerHost!.agentStatus().then(setAgentStatus);
          }}
        />
      )}
    </div>
  );
}
