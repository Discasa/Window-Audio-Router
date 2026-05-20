# Window Audio Router

Window Audio Router is a Manifest V3 extension for Microsoft Edge and Chromium browsers. It lets you choose an audio output device per browser window and adjust the routed volume from a compact popup.

The popup uses English by default and automatically switches to Brazilian Portuguese when the browser or system language reports Portuguese.

## Install In Edge

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder: `F:\scripts\extensions\tab-audio`.

## Use

1. Open an Edge window.
2. Click the Window Audio Router extension icon.
3. Pick an output device from the dropdown.
4. Adjust the volume slider if needed.

There is no Apply button. Device and volume changes are applied immediately to the current window.

## How It Works

- The extension first tries to apply `HTMLMediaElement.setSinkId()` and `element.volume` to page `<audio>` and `<video>` elements.
- For sites that do not reliably follow page-level `setSinkId()`, it captures the active tab audio with `chrome.tabCapture`, plays that stream in an offscreen extension document, and applies `setSinkId()` there.
- Choosing the Windows default option stops the tab capture route and returns playback to the system default.

## Limitations

- Direct page routing only works for compatible `<audio>` and `<video>` elements.
- `tabCapture` routes the active tab selected when the device is chosen.
- Protected content, DRM, special browser pages, blocked iframes, or unusual players may refuse capture or sink selection.
- The volume slider changes the extension playback element volume and page media element volume. It does not change the Windows mixer or hardware device volume.

## Project Files

- `manifest.json` - MV3 extension manifest.
- `popup.html`, `popup.css`, `popup.js` - localized popup interface.
- `service_worker.js` - per-window settings, tab events, script injection, and tab capture routing.
- `offscreen.html`, `offscreen.js` - offscreen audio playback and output selection.
- `content_script.js` - page media element routing fallback.
- `_locales/` - English and Brazilian Portuguese UI strings.
