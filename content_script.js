(() => {
  if (globalThis.__windowAudioRouterContentScriptLoaded) {
    return;
  }

  globalThis.__windowAudioRouterContentScriptLoaded = true;

  const LOG_PREFIX = "[Window Audio Router]";
  const MEDIA_SELECTOR = "audio, video";

  let currentSinkId = "";
  let currentSinkLabel = "";
  let currentVolume = null;
  let observer = null;
  let applyTimer = null;
  let unsupportedLogged = false;

  function normalizeSinkId(sinkId) {
    return typeof sinkId === "string" ? sinkId : "";
  }

  function normalizeVolume(volume) {
    if (volume === null || typeof volume === "undefined") {
      return null;
    }

    const parsedVolume = Number(volume);

    if (!Number.isFinite(parsedVolume)) {
      return null;
    }

    return Math.min(1, Math.max(0, parsedVolume));
  }

  function normalizeDeviceLabel(label) {
    return String(label || "")
      .replace(/^Default\s*-\s*/i, "")
      .replace(/^Communications\s*-\s*/i, "")
      .trim()
      .toLowerCase();
  }

  function serializeDevice(device) {
    return {
      kind: device.kind,
      label: device.label || "",
      deviceId: device.deviceId || "",
      groupId: device.groupId || ""
    };
  }

  function isSpecificOutputDevice(device) {
    return (
      device.kind === "audiooutput" &&
      device.deviceId &&
      device.deviceId !== "default" &&
      device.deviceId !== "communications"
    );
  }

  async function enumerateAudioOutputDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return {
        ok: false,
        error: "enumerateDevices() is not available on this page.",
        devices: []
      };
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(isSpecificOutputDevice).map(serializeDevice);

      return {
        ok: true,
        href: location.href,
        isSecureContext,
        outputs,
        rawDevices: devices.map(serializeDevice)
      };
    } catch (error) {
      return {
        ok: false,
        error: describeError(error),
        devices: []
      };
    }
  }

  async function findOutputDeviceByLabel(preferredSinkLabel) {
    const targetLabel = normalizeDeviceLabel(preferredSinkLabel);

    if (!targetLabel || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return null;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    return devices.find((device) => {
      if (!isSpecificOutputDevice(device)) {
        return false;
      }

      return normalizeDeviceLabel(device.label) === targetLabel;
    }) || null;
  }

  async function resolveSinkIdForPage(preferredSinkId, preferredSinkLabel) {
    const sinkId = normalizeSinkId(preferredSinkId);
    const targetLabel = normalizeDeviceLabel(preferredSinkLabel);

    if (!targetLabel || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return sinkId;
    }

    try {
      let matchedDevice = await findOutputDeviceByLabel(preferredSinkLabel);

      if (matchedDevice && matchedDevice.deviceId) {
        return matchedDevice.deviceId;
      }

    } catch (error) {
      console.info(`${LOG_PREFIX} Could not resolve the page output device by label: ${describeError(error)}`);
    }

    return sinkId;
  }

  function describeError(error) {
    if (!error) {
      return "unknown error";
    }

    return error.message || error.name || String(error);
  }

  function isMediaElement(node) {
    return node instanceof HTMLMediaElement;
  }

  async function applySinkIdToElement(element, sinkId) {
    if (!isMediaElement(element)) {
      return { ok: true, skipped: true, reason: "not-media" };
    }

    // This extension only acts on HTMLMediaElement instances (<audio> and <video>).
    // WebAudio, DRM, protected players, or blocked iframes may not expose
    // setSinkId(), or may reject the deviceId due to site policy.
    if (typeof element.setSinkId !== "function") {
      if (!unsupportedLogged) {
        unsupportedLogged = true;
        console.info(`${LOG_PREFIX} This page/browser does not expose HTMLMediaElement.setSinkId().`);
      }

      return { ok: true, skipped: true, reason: "setSinkId-unavailable" };
    }

    const desiredSinkId = normalizeSinkId(sinkId);

    try {
      if (typeof element.sinkId === "string" && element.sinkId === desiredSinkId) {
        return { ok: true, skipped: true, reason: "already-applied" };
      }

      await element.setSinkId(desiredSinkId);
      return { ok: true, applied: true };
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Could not apply the audio output to this element: ${describeError(error)}`,
        element
      );

      return {
        ok: false,
        error: describeError(error)
      };
    }
  }

  function applyVolumeToElement(element, volume) {
    if (!isMediaElement(element) || volume === null) {
      return { ok: true, skipped: true };
    }

    try {
      if (Math.abs(element.volume - volume) < 0.005) {
        return { ok: true, skipped: true, reason: "already-applied" };
      }

      // Volume is also controlled through HTMLMediaElement. This does not alter
      // the Windows mixer or the native volume of the HDMI/headphone device.
      element.volume = volume;
      return { ok: true, applied: true };
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Could not apply volume to this element: ${describeError(error)}`,
        element
      );

      return {
        ok: false,
        error: describeError(error)
      };
    }
  }

  async function applyAudioSettingsToMediaElements(settings = {}) {
    if (Object.prototype.hasOwnProperty.call(settings, "sinkId")) {
      currentSinkId = normalizeSinkId(settings.sinkId);
    }

    if (Object.prototype.hasOwnProperty.call(settings, "sinkLabel")) {
      currentSinkLabel = typeof settings.sinkLabel === "string" ? settings.sinkLabel : "";
    }

    if (Object.prototype.hasOwnProperty.call(settings, "volume")) {
      currentVolume = normalizeVolume(settings.volume);
    }

    const mediaElements = Array.from(document.querySelectorAll(MEDIA_SELECTOR));
    const pageSinkId = await resolveSinkIdForPage(
      currentSinkId,
      currentSinkLabel
    );

    if (mediaElements.length === 0) {
      return {
        ok: true,
        sinkId: pageSinkId,
        sinkLabel: currentSinkLabel,
        volume: currentVolume,
        total: 0,
        sinkAppliedCount: 0,
        volumeAppliedCount: 0,
        failedCount: 0
      };
    }

    const sinkResults = await Promise.all(
      mediaElements.map((element) => applySinkIdToElement(element, pageSinkId))
    );
    const volumeResults = mediaElements.map((element) =>
      applyVolumeToElement(element, currentVolume)
    );
    const failedCount =
      sinkResults.filter((result) => result.ok === false).length +
      volumeResults.filter((result) => result.ok === false).length;

    const sinkAppliedCount = sinkResults.filter((result) => result.applied).length;
    const volumeAppliedCount = volumeResults.filter((result) => result.applied).length;

    console.debug(
      `${LOG_PREFIX} Applied settings to ${mediaElements.length} media element(s).`
    );

    return {
      ok: failedCount === 0,
      sinkId: pageSinkId,
      sinkLabel: currentSinkLabel,
      volume: currentVolume,
      total: mediaElements.length,
      sinkAppliedCount,
      volumeAppliedCount,
      failedCount
    };
  }

  function applySinkIdToMediaElements(sinkId) {
    return applyAudioSettingsToMediaElements({ sinkId });
  }

  function nodeHasMedia(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    if (node.matches && node.matches(MEDIA_SELECTOR)) {
      return true;
    }

    return Boolean(node.querySelector && node.querySelector(MEDIA_SELECTOR));
  }

  function scheduleApply() {
    if (applyTimer) {
      clearTimeout(applyTimer);
    }

    applyTimer = setTimeout(() => {
      applyTimer = null;
      void applyAudioSettingsToMediaElements();
    }, 120);
  }

  function startObserver() {
    if (observer) {
      return;
    }

    const target = document.documentElement || document.body;

    if (!target) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      const hasNewMedia = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(nodeHasMedia)
      );

      if (hasNewMedia) {
        scheduleApply();
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "APPLY_AUDIO_SETTINGS") {
      applyAudioSettingsToMediaElements({
        sinkId: message.sinkId,
        sinkLabel: message.sinkLabel,
        volume: message.volume
      })
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          console.warn(`${LOG_PREFIX} Failed to apply settings:`, error);
          sendResponse({
            ok: false,
            error: describeError(error)
          });
        });

      return true;
    }

    if (message.type === "GET_PAGE_AUDIO_OUTPUTS") {
      enumerateAudioOutputDevices()
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: describeError(error),
            outputs: []
          });
        });

      return true;
    }

    if (message.type === "APPLY_SINK_ID") {
      applySinkIdToMediaElements(message.sinkId)
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          console.warn(`${LOG_PREFIX} Failed to apply sinkId:`, error);
          sendResponse({
            ok: false,
            error: describeError(error)
          });
        });

      return true;
    }

    return false;
  });

  startObserver();

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        startObserver();
        void applyAudioSettingsToMediaElements({ sinkId: currentSinkId });
      },
      { once: true }
    );
  }

  void applyAudioSettingsToMediaElements({ sinkId: currentSinkId });
})();
