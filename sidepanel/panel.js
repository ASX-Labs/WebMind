// ── State ────────────────────────────────────────────────────────────────────
let state = {
  pageContext: null,
  messages: [],
  streaming: false,
  streamingEl: null,
  streamBuf: '',
  view: 'chat',
  tabId: null,
  pendingSelection: null
};

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  state.tabId = tab.id;

  // Check for pending selection (from context menu)
  const { wmPendingSelection } = await chrome.storage.local.get(['wmPendingSelection']);
  if (wmPendingSelection) {
    state.pendingSelection = wmPendingSelection;
    chrome.storage.local.remove(['wmPendingSelection']);
  }

  // Check if API key exists
  const settings = await sw('GET_SETTINGS');
  const hasKey = settings.openaiKey || settings.anthropicKey || settings.geminiKey;

  // Load saved model
  if (settings.defaultModel) {
    document.getElementById('modelSelect').value = settings.defaultModel;
  }

  if (!hasKey) {
    showState('nokey');
    return;
  }

  // Extract page
  showState('loading');
  await loadPage(tab);
}

async function loadPage(tab) {
  const ctx = await sw('EXTRACT_PAGE', { tabId: tab.id });

  if (ctx.error) {
    // Can't extract (chrome:// pages etc) — open in free chat mode
    state.pageContext = null;
    showPageBar(null, tab.title || 'New tab');
  } else {
    state.pageContext = ctx;
    showPageBar(ctx.type, ctx.title);

    // Load saved history
    const hist = await sw('GET_HISTORY', { url: ctx.url });
    if (hist && hist.messages?.length) {
      state.messages = hist.messages;
      renderAllMessages();
    }
  }

  showState('chat');

  // Show suggestions
  renderSuggestions();

  // Handle pending selection
  if (state.pendingSelection) {
    handleSelection(state.pendingSelection);
    state.pendingSelection = null;
  }

  // Scroll to bottom
  scrollBottom();
}

// ── Page bar ─────────────────────────────────────────────────────────────────
function showPageBar(type, title) {
  const bar = document.getElementById('pageBar');
  const badge = document.getElementById('pageType');
  const titleEl = document.getElementById('pageTitle');

  if (!type) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  badge.className = 'badge ' + (type || '');
  badge.textContent = type === 'youtube' ? 'YouTube' : type === 'pdf' ? 'PDF' : 'Article';
  titleEl.textContent = title || '';
}

// ── View states ───────────────────────────────────────────────────────────────
function showState(s) {
  document.getElementById('loadingState').classList.toggle('hidden', s !== 'loading');
  document.getElementById('noKeyState').classList.toggle('hidden', s !== 'nokey');
  document.getElementById('chatView').classList.toggle('hidden', s !== 'chat');
  document.getElementById('historyView').classList.toggle('hidden', s !== 'history');
}

// ── Suggestions ───────────────────────────────────────────────────────────────
const SUGGESTIONS = {
  youtube: ['Summarize this video', 'What are the main topics?', 'Key takeaways', 'Create notes'],
  pdf: ['Summarize this document', 'What are the key points?', 'Explain the main argument', 'TL;DR'],
  article: ['Summarize this', 'Key takeaways', 'What questions does this raise?', 'Explain simply'],
  default: ['What is this page about?', 'TL;DR', 'Key points', 'What should I know?']
};

function renderSuggestions() {
  const el = document.getElementById('suggestions');
  if (state.messages.length > 0) { el.innerHTML = ''; return; }

  const type = state.pageContext?.type || 'default';
  const list = SUGGESTIONS[type] || SUGGESTIONS.default;

  el.innerHTML = list.map(q =>
    `<button class="suggestion-btn" data-q="${esc(q)}">${esc(q)}</button>`
  ).join('');
}

// ── Messages rendering ────────────────────────────────────────────────────────
function renderAllMessages() {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  state.messages.forEach(m => appendMessage(m.role, m.content));
}

function appendMessage(role, content) {
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `msg msg-${role === 'user' ? 'user' : 'ai'}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'user') {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = md(content);
  }
  div.appendChild(bubble);
  el.appendChild(div);
  return bubble;
}

function appendError(text) {
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  el.appendChild(div);
  scrollBottom();
}

function startStreamingMessage() {
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  const bubble = document.createElement('div');
  bubble.className = 'bubble streaming';
  div.appendChild(bubble);
  el.appendChild(div);
  state.streamingEl = bubble;
  state.streamBuf = '';
  scrollBottom();
  return bubble;
}

function scrollBottom() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function md(text) {
  if (!text) return '';
  let h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Code blocks
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);
  // Inline code
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold / italic
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Blockquote
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // HR
  h = h.replace(/^---$/gm, '<hr>');
  // Unordered list
  h = h.replace(/^(\s*)[*\-] (.+)$/gm, '<li>$2</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  // Ordered list
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Links
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Paragraphs
  h = h.replace(/\n\n/g, '</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/<p><\/p>/g, '');
  h = h.replace(/<p>(<h[1-3]>)/g, '$1');
  h = h.replace(/(<\/h[1-3]>)<\/p>/g, '$1');
  h = h.replace(/<p>(<pre>)/g, '$1');
  h = h.replace(/(<\/pre>)<\/p>/g, '$1');
  h = h.replace(/<p>(<ul>)/g, '$1');
  h = h.replace(/(<\/ul>)<\/p>/g, '$1');
  h = h.replace(/<p>(<hr>)<\/p>/g, '$1');
  h = h.replace(/<p>(<blockquote>)/g, '$1');
  h = h.replace(/(<\/blockquote>)<\/p>/g, '$1');
  h = h.replace(/\n/g, '<br>');
  return h;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function sendMessage(text) {
  if (state.streaming || !text.trim()) return;

  const input = document.getElementById('inputBox');
  input.value = '';
  input.style.height = '';
  document.getElementById('btnSend').disabled = true;

  // Hide suggestions
  document.getElementById('suggestions').innerHTML = '';

  // Add user message
  state.messages.push({ role: 'user', content: text });
  appendMessage('user', text);
  scrollBottom();

  // Start streaming
  state.streaming = true;
  startStreamingMessage();

  const model = document.getElementById('modelSelect').value;
  sw('CHAT_STREAM', {
    messages: state.messages,
    model,
    pageContext: state.pageContext
  });
}

// ── Selection ─────────────────────────────────────────────────────────────────
function handleSelection(text) {
  const toast = document.getElementById('selectionToast');
  const preview = document.getElementById('selectionPreview');
  preview.textContent = '"' + text.slice(0, 80) + (text.length > 80 ? '…' : '') + '"';
  toast.dataset.text = text;
  toast.classList.remove('hidden');
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportChat() {
  if (!state.messages.length) return;
  const title = state.pageContext?.title || 'WebMind Chat';
  const url = state.pageContext?.url || '';
  const date = new Date().toISOString().split('T')[0];

  let md2 = `---\ntitle: "${title}"\nurl: ${url}\ndate: ${date}\n---\n\n# ${title}\n\n`;
  state.messages.forEach(m => {
    md2 += m.role === 'user' ? `**You:** ${m.content}\n\n` : `**WebMind:** ${m.content}\n\n---\n\n`;
  });

  const blob = new Blob([md2], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `webmind-${date}-${title.slice(0,30).replace(/[^a-z0-9]/gi,'-')}.md`;
  a.click();
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const list = await sw('LIST_HISTORY');
  const el = document.getElementById('historyList');
  if (!list.length) {
    el.innerHTML = '<p style="color:var(--text3);text-align:center;padding:20px;font-size:12px">No saved conversations yet</p>';
    return;
  }
  el.innerHTML = list.map(item => {
    const ago = timeAgo(item.ts);
    return `<div class="history-item" data-url="${esc(item.url)}">
      <div class="history-item-left">
        <div class="history-item-title">${esc(item.title || item.url)}</div>
        <div class="history-item-meta">${ago} · ${item.count} messages</div>
      </div>
      <span class="history-item-del" data-del="${esc(item.url)}">✕</span>
    </div>`;
  }).join('');
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return Math.floor(diff/86400000) + 'd ago';
}

// ── Util ──────────────────────────────────────────────────────────────────────
function sw(type, data = {}) {
  return new Promise(r => chrome.runtime.sendMessage({ type, ...data }, r));
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('btnGoOptions')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('btnRefresh').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  state.messages = [];
  state.pageContext = null;
  document.getElementById('messages').innerHTML = '';
  showState('loading');
  await loadPage(tab);
});

document.getElementById('btnHistory').addEventListener('click', () => {
  if (state.view === 'history') {
    state.view = 'chat';
    showState('chat');
    document.getElementById('btnHistory').classList.remove('active');
  } else {
    state.view = 'history';
    showState('history');
    document.getElementById('btnHistory').classList.add('active');
    loadHistory();
  }
});

document.getElementById('btnExport').addEventListener('click', exportChat);

document.getElementById('btnClear').addEventListener('click', async () => {
  state.messages = [];
  document.getElementById('messages').innerHTML = '';
  renderSuggestions();
  if (state.pageContext?.url) {
    await sw('DELETE_HISTORY', { url: state.pageContext.url });
  }
});

document.getElementById('btnClearHistory').addEventListener('click', async () => {
  if (!confirm('Clear all chat history?')) return;
  await sw('CLEAR_ALL_HISTORY');
  loadHistory();
});

document.getElementById('btnSend').addEventListener('click', () => {
  const text = document.getElementById('inputBox').value.trim();
  if (text) sendMessage(text);
});

document.getElementById('inputBox').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = document.getElementById('inputBox').value.trim();
    if (text) sendMessage(text);
  }
});

document.getElementById('inputBox').addEventListener('input', function() {
  this.style.height = '';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  document.getElementById('btnSend').disabled = !this.value.trim() || state.streaming;
});

document.getElementById('suggestions').addEventListener('click', (e) => {
  const btn = e.target.closest('.suggestion-btn');
  if (btn) sendMessage(btn.dataset.q);
});

document.getElementById('btnAskSelection')?.addEventListener('click', () => {
  const toast = document.getElementById('selectionToast');
  const text = toast.dataset.text;
  toast.classList.add('hidden');
  sendMessage(`Explain this: "${text}"`);
});

document.getElementById('btnDismissSelection')?.addEventListener('click', () => {
  document.getElementById('selectionToast').classList.add('hidden');
});

document.getElementById('historyList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    await sw('DELETE_HISTORY', { url: del.dataset.del });
    loadHistory();
    return;
  }
  const item = e.target.closest('.history-item');
  if (item) {
    const url = item.dataset.url;
    const hist = await sw('GET_HISTORY', { url });
    if (hist) {
      state.messages = hist.messages;
      state.pageContext = { url: hist.url, title: hist.title, type: 'article', content: '' };
      showPageBar('article', hist.title);
      state.view = 'chat';
      showState('chat');
      document.getElementById('btnHistory').classList.remove('active');
      renderAllMessages();
      scrollBottom();
    }
  }
});

document.getElementById('modelSelect').addEventListener('change', async (e) => {
  const settings = await sw('GET_SETTINGS');
  settings.defaultModel = e.target.value;
  await sw('SAVE_SETTINGS', { settings });
});

// ── Service worker messages ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHAT_CHUNK') {
    if (!state.streamingEl) return;
    state.streamBuf += msg.text;
    state.streamingEl.innerHTML = md(state.streamBuf);
    state.streamingEl.classList.add('streaming');
    scrollBottom();
  } else if (msg.type === 'CHAT_DONE') {
    if (!state.streamingEl) return;
    state.streamingEl.classList.remove('streaming');
    state.streamingEl.innerHTML = md(state.streamBuf);
    state.messages.push({ role: 'assistant', content: state.streamBuf });
    state.streaming = false;
    state.streamingEl = null;
    document.getElementById('btnSend').disabled = !document.getElementById('inputBox').value.trim();
    // Auto-save history
    if (state.pageContext?.url) {
      sw('SAVE_HISTORY', { url: state.pageContext.url, title: state.pageContext.title, messages: state.messages });
    }
    scrollBottom();
  } else if (msg.type === 'CHAT_ERROR') {
    if (state.streamingEl) {
      state.streamingEl.closest('.msg').remove();
      state.streamingEl = null;
    }
    state.streaming = false;
    state.messages.pop(); // remove last user message
    appendError(msg.error);
    document.getElementById('btnSend').disabled = !document.getElementById('inputBox').value.trim();
  } else if (msg.type === 'SELECTION_CHANGED') {
    if (state.view === 'chat' && !state.streaming) {
      handleSelection(msg.text);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
init();
