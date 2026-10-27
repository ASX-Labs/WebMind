function sw(type, data = {}) {
  return new Promise(r => chrome.runtime.sendMessage({ type, ...data }, r));
}

async function load() {
  const s = await sw('GET_SETTINGS');
  if (s.openaiKey)     document.getElementById('openaiKey').value = s.openaiKey;
  if (s.anthropicKey)  document.getElementById('anthropicKey').value = s.anthropicKey;
  if (s.geminiKey)     document.getElementById('geminiKey').value = s.geminiKey;
  if (s.defaultModel)  document.getElementById('defaultModel').value = s.defaultModel;
  if (s.maxChars)      document.getElementById('maxChars').value = s.maxChars;
}

async function save() {
  const settings = {
    openaiKey:    document.getElementById('openaiKey').value.trim(),
    anthropicKey: document.getElementById('anthropicKey').value.trim(),
    geminiKey:    document.getElementById('geminiKey').value.trim(),
    defaultModel: document.getElementById('defaultModel').value,
    maxChars:     document.getElementById('maxChars').value
  };
  await sw('SAVE_SETTINGS', { settings });
  const st = document.getElementById('saveStatus');
  st.textContent = 'Saved!';
  setTimeout(() => { st.textContent = ''; }, 2000);
}

// Show/hide key
document.querySelectorAll('.show-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = document.getElementById(btn.dataset.target);
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide'; }
    else { inp.type = 'password'; btn.textContent = 'Show'; }
  });
});

// Test connection
document.querySelectorAll('.test-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.provider;
    const statusEl = document.getElementById(provider + 'Status');
    const key = document.getElementById(provider + 'Key').value.trim();
    if (!key) { statusEl.className = 'key-status err'; statusEl.textContent = 'No key entered'; return; }
    btn.textContent = 'Testing…'; btn.disabled = true;
    try {
      let ok = false;
      if (provider === 'openai') {
        const r = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${key}` } });
        ok = r.ok;
      } else if (provider === 'anthropic') {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
        });
        ok = r.status !== 401;
      } else if (provider === 'gemini') {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        ok = r.ok;
      }
      statusEl.className = 'key-status ' + (ok ? 'ok' : 'err');
      statusEl.textContent = ok ? '✓ Connection successful' : '✗ Invalid key';
    } catch (e) {
      statusEl.className = 'key-status err';
      statusEl.textContent = '✗ ' + e.message;
    }
    btn.textContent = 'Test'; btn.disabled = false;
  });
});

document.getElementById('btnSave').addEventListener('click', save);

document.getElementById('btnClearHistory').addEventListener('click', async () => {
  if (!confirm('This will delete all saved chat history. Continue?')) return;
  await sw('CLEAR_ALL_HISTORY');
  alert('History cleared.');
});

document.getElementById('btnExportSettings').addEventListener('click', async () => {
  const s = await sw('GET_SETTINGS');
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'webmind-settings.json';
  a.click();
});

document.getElementById('btnImportSettings').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const s = JSON.parse(text);
    await sw('SAVE_SETTINGS', { settings: s });
    await load();
    alert('Settings imported!');
  } catch (_) { alert('Invalid settings file.'); }
});

load();
