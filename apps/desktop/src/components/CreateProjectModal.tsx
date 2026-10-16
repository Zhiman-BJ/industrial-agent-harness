import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Download, X } from 'lucide-react';
import type { DomainOption } from '@industrial-agent-harness/viewer-builtin/api';

type Draft = { directory: string; name: string; domain: string };

const DOMAIN_DESCRIPTIONS: Record<string, string> = {
  chip: 'Chip design: RTL, synthesis, netlist, GDS layout and waveform review.',
  pcb: 'PCB design: schematics, layout, fabrication outputs (KiCad).',
  cad: 'Mechanical CAD: 3D models and drawings (FreeCAD).',
  cuda: 'GPU compute: CUDA kernels and performance work.',
  godot: 'Game/simulation engineering with the Godot engine.',
};

export function CreateProjectModal({
  draft,
  domains,
  error,
  onChange,
  onChooseDirectory,
  onManageDomains,
  onClose,
  onCreate,
}: {
  draft: Draft;
  domains: DomainOption[];
  error: string;
  onChange: (draft: Draft) => void;
  onChooseDirectory: () => Promise<void>;
  onManageDomains: () => void;
  onClose: () => void;
  onCreate: (request: Draft) => Promise<void>;
}) {
  const { t } = useDisplayText();
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const selected = domains.find(item => item.id === draft.domain);
  const hasPacks = domains.some(item => !item.builtin);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function create() {
    if (saving || !selected || !draft.directory || !draft.name.trim()) return;
    setSaving(true);
    try {
      await onCreate(draft);
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ia-model-modal ia-create-project"
      aria-label={t('Create project')}
      onCancel={event => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <div>
          <h2>{t('New project')}</h2>
          <p>{t('Choose a folder and a domain for this project.')}</p>
        </div>
        <button disabled={saving} onClick={onClose} aria-label={t('Close project creation')}>
          <X size={17} />
        </button>
      </header>
      <div className="ia-model-fields">
        <label>
          {t('Project name')}{' '}
          <input
            value={draft.name}
            disabled={saving}
            onChange={event => onChange({ ...draft, name: event.target.value })}
            maxLength={100}
            placeholder={t('Project name')}
          />
        </label>
        <div className="ia-create-field">
          <span>{t('Local directory')}</span>
          <button
            disabled={saving}
            className="ia-folder-picker"
            onClick={() => void onChooseDirectory()}
          >
            <FolderOpen size={15} />
            <span>{draft.directory || t('Choose folder…')}</span>
          </button>
          <small className="ia-create-hint">
            {t('Existing files are kept as-is; the agent only writes after you approve an action.')}
          </small>
        </div>
        <div className="ia-create-field">
          <span>{t('Domain')}</span>
          <div className="ia-domain-choices" role="group" aria-label={t('New project domain')}>
            {domains.map(item => (
              <button
                key={item.id}
                type="button"
                disabled={saving}
                className="ia-domain-choice"
                data-domain={item.id}
                aria-pressed={draft.domain === item.id}
                title={t(
                  item.builtin
                    ? 'Built in · No installation required'
                    : DOMAIN_DESCRIPTIONS[item.id] || item.label,
                )}
                onClick={() => onChange({ ...draft, domain: item.id })}
              >
                <DomainIcon domain={item.id} />
                {t(item.label)}
              </button>
            ))}
          </div>
          {selected?.builtin && (
            <small className="ia-create-hint">
              {t(
                'General projects support everyday coding and file tasks. No domain pack is required.',
              )}
            </small>
          )}
          {draft.domain && DOMAIN_DESCRIPTIONS[draft.domain] && (
            <small className="ia-create-hint">{t(DOMAIN_DESCRIPTIONS[draft.domain])}</small>
          )}
          <div className="ia-create-domains-guide">
            <div>
              <strong>
                {t(
                  hasPacks
                    ? 'Need another domain?'
                    : 'Start with General, or add a specialized domain',
                )}
              </strong>
              <p>
                {t(
                  'Domain packs add specialized tools and skills. You can change the domain later in project details.',
                )}
              </p>
            </div>
            <button disabled={saving} className="ia-create-install" onClick={onManageDomains}>
              <Download size={15} />
              {t('Install domain packs')}
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="ia-model-error">
            {t(error)}
          </p>
        )}
      </div>
      <footer>
        <span />
        <button disabled={saving} onClick={onClose}>
          {t('Cancel')}
        </button>
        <button
          className="primary"
          onClick={() => void create()}
          disabled={saving || !draft.directory || !draft.name.trim() || !selected}
        >
          {saving ? t('Creating…') : t('Create project')}
        </button>
      </footer>
    </dialog>
  );
}
