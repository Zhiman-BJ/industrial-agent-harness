const labels = {chip: 'Chip', pcb: 'PCB'};
const emojis = {chip: '💠', pcb: '🔌'};

function listDomains(capabilities) {
  return [...new Set(capabilities.map(item => item.domain).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({id, label: labels[id] || id.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '), emoji: emojis[id] || '⚙️'}));
}

module.exports = {listDomains};
