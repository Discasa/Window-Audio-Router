# Window Audio Router Documentation

## Goal

Window Audio Router provides per-window output routing for Edge/Chromium without changing the native Windows default audio device or the whole browser process output.

## Architecture

The extension uses two layers:

- Page media fallback: `content_script.js` finds `audio, video` elements, applies `HTMLMediaElement.setSinkId(sinkId)`, applies `element.volume`, and watches dynamic DOM changes with `MutationObserver`.
- Active tab capture route: `service_worker.js` obtains a `chrome.tabCapture` stream ID for the active tab, then `offscreen.js` consumes the stream with `getUserMedia({ chromeMediaSource: "tab" })`, plays it through an `HTMLAudioElement`, and applies `setSinkId()` to that element.

The tab capture route exists because many real-world sites do not expose a normal page media element or do not accept page-origin sink IDs reliably.

## Per-Window State

Settings are stored in `chrome.storage.local` under `windowAudioSettings`:

```json
{
  "123": {
    "sinkId": "device-id",
    "sinkLabel": "Device label",
    "volume": 1
  }
}
```

The `windowId` key is removed when the window is closed.

## Localization

The extension declares `default_locale: "en"` and uses Chrome i18n message files:

- `_locales/en/messages.json`
- `_locales/pt_BR/messages.json`

The popup HTML contains neutral default English text. `popup.js` applies localized messages at startup through `chrome.i18n.getMessage()`.

## Known Browser Constraints

- `chrome.tabCapture` requires a user gesture through the extension and may fail when called from automated tooling.
- Internal browser pages and protected content may not be capturable.
- `setSinkId()` availability and device labels depend on Chromium media permissions.
- Device IDs are origin scoped. The popup enumerates devices from the extension origin because the offscreen audio element also runs in the extension origin.

## Validation

Run syntax checks with:

```powershell
node --check service_worker.js
node --check offscreen.js
node --check popup.js
node --check content_script.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```
