# Privacy Policy — WebMind

**Last updated: September 26, 2026**

## Data Collection

WebMind does **not** collect, store, or transmit any personal data to external servers.

## What stays on your device

- Chat history (stored in `chrome.storage.local`)
- API keys (stored in `chrome.storage.local`, never transmitted except to the respective AI provider)
- Extension settings and preferences

## API Calls

When you send a message, the page content and your message are sent directly from your browser to the AI provider you selected (OpenAI, Anthropic, or Google). This communication is between your browser and the provider — ASX Labs has no access to this data.

Please review the privacy policies of your chosen AI provider:
- OpenAI: https://openai.com/privacy
- Anthropic: https://www.anthropic.com/privacy
- Google: https://policies.google.com/privacy

## Permissions

- **storage**: Save chat history and settings locally
- **activeTab / scripting**: Read page content of the active tab when you open WebMind
- **contextMenus**: Add "Ask WebMind" to right-click menu
- **sidePanel**: Display the WebMind chat panel
- **host_permissions (all_urls)**: Required to extract content from any webpage and to call AI APIs

## Contact

For questions: https://github.com/ASX-Labs/WebMind/issues
