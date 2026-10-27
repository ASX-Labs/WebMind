// Listen for messages from the panel/service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') { sendResponse({ ok: true }); return false; }
});

// Track text selection and notify panel
let selectionTimeout;
document.addEventListener('mouseup', () => {
  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 10) {
      chrome.runtime.sendMessage({ type: 'SELECTION_CHANGED', text: text.slice(0, 2000) }).catch(() => {});
    }
  }, 300);
});
