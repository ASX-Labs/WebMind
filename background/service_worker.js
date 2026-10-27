chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ask-webmind',
    title: 'Ask WebMind about this',
    contexts: ['selection']
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) chrome.sidePanel.open({ tabId: tab.id });
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ask-webmind' && info.selectionText) {
    chrome.storage.local.set({ wmPendingSelection: info.selectionText.slice(0, 2000) });
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'EXTRACT_PAGE':
      extractPage(msg.tabId).then(sendResponse);
      return true;
    case 'FETCH_TRANSCRIPT':
      fetchTranscript(msg.url).then(sendResponse);
      return true;
    case 'CHAT_STREAM':
      streamChat(msg);
      sendResponse({ ok: true });
      return false;
    case 'GET_HISTORY':
      getHistory(msg.url).then(sendResponse);
      return true;
    case 'SAVE_HISTORY':
      saveHistory(msg.url, msg.title, msg.messages).then(() => sendResponse({ ok: true }));
      return true;
    case 'LIST_HISTORY':
      listHistory().then(sendResponse);
      return true;
    case 'DELETE_HISTORY':
      deleteHistory(msg.url).then(() => sendResponse({ ok: true }));
      return true;
    case 'CLEAR_ALL_HISTORY':
      clearAllHistory().then(() => sendResponse({ ok: true }));
      return true;
    case 'GET_SETTINGS':
      chrome.storage.local.get(['wmSettings'], (r) => sendResponse(r.wmSettings || {}));
      return true;
    case 'SAVE_SETTINGS':
      chrome.storage.local.set({ wmSettings: msg.settings }, () => sendResponse({ ok: true }));
      return true;
  }
});

// ── Page extraction ──────────────────────────────────────────────────────────

async function extractPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent
    });
    const data = results[0]?.result;
    if (!data) return { error: 'Could not extract content' };

    // Fetch YouTube transcript if needed
    if (data.transcriptUrl) {
      const transcript = await fetchTranscript(data.transcriptUrl);
      data.content = transcript || data.content;
      delete data.transcriptUrl;
    }
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

function extractPageContent() {
  const url = location.href;
  const title = document.title;

  // YouTube
  if (location.hostname.includes('youtube.com') && location.search.includes('v=')) {
    let transcriptUrl = null;
    try {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        if (!s.textContent.includes('captionTracks')) continue;
        const m = s.textContent.match(/"captionTracks":(\[[\s\S]*?\])/);
        if (m) {
          const tracks = JSON.parse(m[1]);
          const en = tracks.find(t => t.languageCode === 'en') || tracks[0];
          if (en) { transcriptUrl = en.baseUrl; break; }
        }
      }
    } catch (_) {}

    const desc = document.querySelector('meta[name="description"]')?.content || '';
    const channel = document.querySelector('[itemprop="author"] [itemprop="name"]')?.content || '';
    const fallback = `[YouTube Video]\nTitle: ${title}\nChannel: ${channel}\n\n${desc}`;
    return { url, title, type: 'youtube', content: fallback, transcriptUrl };
  }

  // Determine type
  let type = 'article';
  if (url.endsWith('.pdf') || document.contentType === 'application/pdf') type = 'pdf';

  // Extract main content
  const priority = ['article', 'main', '[role="main"]', '.article-body', '.post-content',
    '.entry-content', '.content', '#content', '#main', '.markdown-body'];
  let root = null;
  for (const sel of priority) { root = document.querySelector(sel); if (root) break; }
  if (!root) root = document.body;

  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,nav,header,footer,aside,iframe,noscript,[role="navigation"],[role="banner"],[role="complementary"],form,.cookie-banner,.popup,.modal,.ad,.advertisement').forEach(el => el.remove());

  let content = clone.innerText.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const maxChars = 20000;
  if (content.length > maxChars) content = content.slice(0, maxChars) + '\n\n[Content truncated — showing first 20,000 characters]';

  return { url, title, type, content };
}

async function fetchTranscript(transcriptUrl) {
  try {
    const res = await fetch(transcriptUrl + '&fmt=vtt');
    if (!res.ok) throw new Error('fetch failed');
    const text = await res.text();
    // Parse VTT/XML transcript
    let lines = text
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^\d+$/.test(l) && !/^\d{2}:\d{2}/.test(l) && l !== 'WEBVTT');
    // Deduplicate consecutive identical lines
    const deduped = lines.filter((l, i) => l !== lines[i - 1]);
    return deduped.join(' ').replace(/\s{2,}/g, ' ');
  } catch (_) {
    return null;
  }
}

// ── AI Streaming ─────────────────────────────────────────────────────────────

async function streamChat(msg) {
  const { messages, model, pageContext } = msg;
  const settings = await new Promise(r => chrome.storage.local.get(['wmSettings'], d => r(d.wmSettings || {})));

  const systemPrompt = buildSystemPrompt(pageContext);
  const provider = getProvider(model);
  const key = settings[`${provider}Key`];

  if (!key) {
    broadcast({ type: 'CHAT_ERROR', error: `No ${provider} API key set. Open Options (gear icon) to add your key.` });
    return;
  }

  try {
    if (provider === 'openai')    await streamOpenAI(key, model, systemPrompt, messages);
    else if (provider === 'anthropic') await streamAnthropic(key, model, systemPrompt, messages);
    else if (provider === 'gemini')    await streamGemini(key, model, systemPrompt, messages);
  } catch (e) {
    broadcast({ type: 'CHAT_ERROR', error: e.message });
  }
}

function buildSystemPrompt(ctx) {
  if (!ctx) return 'You are WebMind, a helpful AI assistant built into the browser.';
  const typeLabel = ctx.type === 'youtube' ? 'YouTube video' : ctx.type === 'pdf' ? 'PDF document' : 'webpage';
  return `You are WebMind, an AI assistant helping the user understand and discuss a ${typeLabel}.

Page title: ${ctx.title}
URL: ${ctx.url}

${ctx.type === 'youtube' ? 'Video transcript' : 'Page content'}:
---
${ctx.content || '(no content extracted)'}
---

Answer questions accurately based on the content above. If the user asks about something not covered, say so. Be concise and clear.`;
}

function getProvider(model) {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'gemini';
  return 'openai';
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function streamOpenAI(key, model, systemPrompt, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      max_tokens: 2048
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') { broadcast({ type: 'CHAT_DONE' }); return; }
      try {
        const text = JSON.parse(raw).choices?.[0]?.delta?.content;
        if (text) broadcast({ type: 'CHAT_CHUNK', text });
      } catch (_) {}
    }
  }
  broadcast({ type: 'CHAT_DONE' });
}

async function streamAnthropic(key, model, systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, system: systemPrompt, messages, max_tokens: 2048, stream: true })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (d.type === 'content_block_delta' && d.delta?.text)
          broadcast({ type: 'CHAT_CHUNK', text: d.delta.text });
        else if (d.type === 'message_stop') { broadcast({ type: 'CHAT_DONE' }); return; }
      } catch (_) {}
    }
  }
  broadcast({ type: 'CHAT_DONE' });
}

async function streamGemini(key, model, systemPrompt, messages) {
  const geminiMsgs = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMsgs,
        generationConfig: { maxOutputTokens: 2048 }
      })
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Gemini streams a JSON array; parse text parts incrementally
    const matches = buf.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
    for (const m of matches) {
      const text = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (text) broadcast({ type: 'CHAT_CHUNK', text });
    }
    if (buf.length > 50000) buf = buf.slice(-5000);
  }
  broadcast({ type: 'CHAT_DONE' });
}

// ── History ──────────────────────────────────────────────────────────────────

function histKey(url) {
  return 'wm_h_' + btoa(encodeURIComponent(url)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 44);
}

async function getHistory(url) {
  const k = histKey(url);
  return new Promise(r => chrome.storage.local.get([k], d => r(d[k] || null)));
}

async function saveHistory(url, title, messages) {
  const k = histKey(url);
  return new Promise(r => chrome.storage.local.set({ [k]: { url, title, messages, ts: Date.now() } }, r));
}

async function listHistory() {
  return new Promise(r => chrome.storage.local.get(null, items => {
    const list = Object.values(items)
      .filter(v => v && v.url && v.ts)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100)
      .map(v => ({ url: v.url, title: v.title, ts: v.ts, count: v.messages?.length || 0 }));
    r(list);
  }));
}

async function deleteHistory(url) {
  return new Promise(r => chrome.storage.local.remove([histKey(url)], r));
}

async function clearAllHistory() {
  return new Promise(r => chrome.storage.local.get(null, items => {
    const keys = Object.keys(items).filter(k => k.startsWith('wm_h_'));
    chrome.storage.local.remove(keys, r);
  }));
}
