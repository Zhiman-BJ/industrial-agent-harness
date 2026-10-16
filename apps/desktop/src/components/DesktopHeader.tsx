import {
  Bug,
  ChevronDown,
  Columns2,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
} from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { WindowControls } from './WindowControls';

/** Display-only shell navigation; App owns the existing page and layout state. */
export function DesktopHeader({
  projectName,
  location,
  hasProject,
  sidebarVisible,
  workspaceVisible,
  tabbed,
  canSplit,
  debug,
  onProject,
  onSidebar,
  onWorkspace,
  onLayout,
  onLogs,
  onDebug,
}: {
  projectName: string;
  location: string;
  hasProject: boolean;
  sidebarVisible: boolean;
  workspaceVisible: boolean;
  tabbed: boolean;
  canSplit: boolean;
  debug: boolean;
  onProject: () => void;
  onSidebar: () => void;
  onWorkspace: () => void;
  onLayout: () => void;
  onLogs: () => void;
  onDebug: () => void;
}) {
  const { t } = useDisplayText();
  const sidebarLabel = sidebarVisible ? t('Hide sidebar') : t('Show sidebar');
  const workspaceLabel = workspaceVisible ? t('Hide workspace') : t('Show workspace');
  const layoutLabel = tabbed ? t('Use split layout') : t('Use tab layout');
  return (
    <header className="ia-desktop-header">
      <button
        className="ia-icon"
        data-testid="sidebar-toggle"
        onClick={onSidebar}
        title={sidebarLabel}
        aria-label={sidebarLabel}
        aria-expanded={sidebarVisible}
        aria-controls="ia-project-sidebar"
      >
        {sidebarVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
      </button>
      <div className="ia-desktop-context">
        <button
          className="ia-header-project"
          onClick={onProject}
          disabled={!hasProject}
          title={projectName}
          aria-label={t('Project details: {0}', { '0': projectName })}
        >
          <Folder size={16} />
          <b data-testid="header-project" title={projectName}>
            {projectName}
          </b>
          {hasProject && <ChevronDown size={13} />}
        </button>
        <span className="ia-header-separator" aria-hidden="true">
          /
        </span>
        <span className="ia-header-location" data-testid="header-location" title={location}>
          {location}
        </span>
      </div>
      <div className="ia-desktop-actions">
        <button
          className="ia-layout-toggle"
          onClick={onLayout}
          title={
            tabbed && !canSplit ? t('Split layout is available in a wider window') : layoutLabel
          }
          aria-label={layoutLabel}
          disabled={tabbed && !canSplit}
        >
          {tabbed ? <Columns2 size={16} /> : <PanelsTopLeft size={16} />}
        </button>
        <button
          className="ia-log-button"
          aria-label={t('View agent logs')}
          title={t('View detailed agent logs')}
          disabled={!hasProject}
          onClick={onLogs}
        >
          {t('Logs')}
        </button>
        <button
          onClick={onDebug}
          title={t('Toggle debug logs')}
          aria-label={t('Toggle debug logs')}
          aria-pressed={debug}
        >
          <Bug size={15} />
        </button>
        <button
          data-testid="workspace-toggle"
          onClick={onWorkspace}
          title={workspaceLabel}
          aria-label={workspaceLabel}
          aria-pressed={workspaceVisible}
        >
          {workspaceVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
      <WindowControls />
    </header>
  );
}
