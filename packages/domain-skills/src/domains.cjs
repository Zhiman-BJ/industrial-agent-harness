const labels = {chip: 'Chip', pcb: 'PCB'};

function listDomains(capabilities) {
  return [...new Set(capabilities.map(item => item.domain).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({id, label: labels[id] || id.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}));
}

module.exports = {listDomains};
