const metadata = require('@zhiman-bj/industrial-domain-packs').consumerMetadata();
const labels = Object.fromEntries(metadata.domains.map(item => [item.id, item.label]));
const emojis = Object.fromEntries(metadata.domains.map(item => [item.id, item.emoji]));

// The host workspace works without an industrial Pack.
function builtInDomains() {
  return [{ id: 'general', label: 'General', emoji: '⚙️', builtin: true }];
}

function listDomains(capabilities) {
  const domains = [
    ...new Set([
      ...capabilities.map(item => item.domain).filter(Boolean),
      ...metadata.domains.map(item => item.id),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({
      id,
      label:
        labels[id] ||
        id
          .split(/[-_]/)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' '),
      emoji: emojis[id] || '⚙️',
    }));
  const builtins = builtInDomains();
  return [
    ...builtins,
    ...domains.filter(item => !builtins.some(builtin => builtin.id === item.id)),
  ];
}

module.exports = { listDomains, builtInDomains };
