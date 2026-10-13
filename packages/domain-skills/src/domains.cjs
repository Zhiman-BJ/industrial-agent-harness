const { distributionDomain } = require('./distribution.cjs');
const metadata = require('@zhiman-bj/industrial-domain-packs').consumerMetadata();
const labels = Object.fromEntries(metadata.domains.map(item => [item.id, item.label]));
const emojis = Object.fromEntries(metadata.domains.map(item => [item.id, item.emoji]));

// Withdrawal affects current product choices, never historical registry loading.
// Domains supplied by independently installed packs remain eligible by default.
function isDomainOffered(domain) {
  return !(metadata.withdrawnDomains || []).includes(domain);
}

function listDomains(capabilities) {
  return [
    ...new Set(
      distributionDomain
        ? [distributionDomain]
        : [
            ...capabilities.map(item => item.domain).filter(Boolean),
            ...metadata.domains.map(item => item.id),
          ],
    ),
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
}

module.exports = { listDomains, isDomainOffered };
