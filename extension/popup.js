// Popup script — Distock Extension

const toggle = document.getElementById('toggle-enabled');
const statusDot = document.getElementById('status-dot');
const statusTitle = document.getElementById('status-title');
const statusSub = document.getElementById('status-sub');
const versionBadge = document.getElementById('version-badge');

// Affiche la version
const manifest = chrome.runtime.getManifest();
if (versionBadge) versionBadge.textContent = `v${manifest.version}`;

// Charge l'état actuel
chrome.storage.local.get(['enabled'], (result) => {
  const enabled = result.enabled !== false;
  applyState(enabled);
  toggle.checked = enabled;
});

// Écoute le toggle
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.runtime.sendMessage({ type: 'DISTOCK_SET_ENABLED', enabled }, () => {
    applyState(enabled);
  });
});

// Applique visuellement l'état
function applyState(enabled) {
  if (enabled) {
    statusDot.className = 'status-dot';
    statusTitle.textContent = 'CORS Bypass Actif';
    statusSub.textContent = 'Connexion directe au CDN Discord';
  } else {
    statusDot.className = 'status-dot off';
    statusTitle.textContent = 'Extension en pause';
    statusSub.textContent = 'Distock utilise les proxys tiers';
  }
}
