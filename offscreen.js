const LOG_PREFIX = "[Window Audio Router Offscreen]";
const captures = new Map();

function normalizeSinkId(sinkId) {
  return typeof sinkId === "string" ? sinkId : "";
}

function normalizeVolume(volume) {
  const parsedVolume = Number(volume);

  if (!Number.isFinite(parsedVolume)) {
    return 1;
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

function isSpecificOutputDevice(device) {
  return (
    device &&
    device.kind === "audiooutput" &&
    device.deviceId &&
    device.deviceId !== "default" &&
    device.deviceId !== "communications"
  );
}

function describeError(error) {
  if (!error) {
    return "unknown error";
  }

  return error.message || error.name || String(error);
}

async function findOutputDeviceByLabel(label) {
  const normalizedLabel = normalizeDeviceLabel(label);

  if (!normalizedLabel || !navigator.mediaDevices?.enumerateDevices) {
    return null;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  return devices.find((device) => {
    if (!isSpecificOutputDevice(device)) {
      return false;
    }

    return normalizeDeviceLabel(device.label) === normalizedLabel;
  }) || null;
}

async function getCandidateSinkIds(sinkId, sinkLabel) {
  const candidates = [];
  const normalizedSinkId = normalizeSinkId(sinkId);

  if (normalizedSinkId) {
    candidates.push(normalizedSinkId);
  }

  const matchedDevice = await findOutputDeviceByLabel(sinkLabel);

  if (matchedDevice?.deviceId && !candidates.includes(matchedDevice.deviceId)) {
    candidates.push(matchedDevice.deviceId);
  }

  if (candidates.length === 0) {
    candidates.push("");
  }

  return candidates;
}

function stopCapture(tabId) {
  const existing = captures.get(tabId);

  if (!existing) {
    return false;
  }

  existing.audio.pause();
  existing.audio.srcObject = null;
  existing.stream.getTracks().forEach((track) => {
    track.stop();
  });
  existing.audio.remove();
  captures.delete(tabId);

  console.info(`${LOG_PREFIX} Stopped capture for tab ${tabId}.`);
  return true;
}

function stopWindowCaptures(windowId) {
  let stoppedCount = 0;

  for (const [tabId, capture] of captures) {
    if (capture.windowId === windowId) {
      stopCapture(tabId);
      stoppedCount += 1;
    }
  }

  return stoppedCount;
}

async function applyOutputToCapture(capture, sinkId, sinkLabel, volume) {
  const normalizedVolume = normalizeVolume(volume);

  capture.sinkLabel = typeof sinkLabel === "string" ? sinkLabel : "";
  capture.volume = normalizedVolume;
  capture.audio.volume = normalizedVolume;

  if (typeof capture.audio.setSinkId !== "function") {
    if (sinkId) {
      throw new Error("setSinkId() is not available in the offscreen document.");
    }

    await capture.audio.play();
    return;
  }

  const candidates = await getCandidateSinkIds(sinkId, capture.sinkLabel);
  let lastError = null;

  for (const candidateSinkId of candidates) {
    try {
      await capture.audio.setSinkId(candidateSinkId);
      capture.sinkId = candidateSinkId;
      await capture.audio.play();
      return;
    } catch (error) {
      lastError = error;
      console.info(
        `${LOG_PREFIX} Rejected sinkId in offscreen document (${candidateSinkId || "default"}): ${describeError(error)}`
      );
    }
  }

  throw new Error(describeError(lastError) || "Could not select the audio output.");
}

async function startTabCaptureAudio(message) {
  const tabId = Number(message.tabId);
  const windowId = Number(message.windowId);
  const streamId = message.streamId;

  if (!Number.isInteger(tabId) || !streamId) {
    throw new Error("Invalid data for tab capture.");
  }

  stopCapture(tabId);

  /*
   * This strategy captures the mixed tab audio and plays it through an
   * HTMLAudioElement in the extension offscreen document. It avoids relying on
   * the page player, but still uses setSinkId() to choose the output device.
   */
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.dataset.windowAudioRouterTabId = String(tabId);
  document.body.appendChild(audio);

  const capture = {
    tabId,
    windowId,
    stream,
    audio,
    sinkId: "",
    sinkLabel: "",
    volume: 1
  };

  captures.set(tabId, capture);

  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      stopCapture(tabId);
    });
  });

  try {
    await applyOutputToCapture(capture, message.sinkId, message.sinkLabel, message.volume);
  } catch (error) {
    stopCapture(tabId);
    throw error;
  }

  console.info(`${LOG_PREFIX} Capturing tab ${tabId} to the selected output.`);

  return {
    ok: true,
    tabId,
    windowId,
    sinkId: capture.sinkId,
    sinkLabel: capture.sinkLabel,
    volume: capture.volume
  };
}

async function updateWindowCaptures(message) {
  const windowId = Number(message.windowId);
  const updates = [];

  for (const capture of captures.values()) {
    if (capture.windowId === windowId) {
      await applyOutputToCapture(capture, message.sinkId, message.sinkLabel, message.volume);
      updates.push(capture.tabId);
    }
  }

  return {
    ok: true,
    updatedTabIds: updates
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "START_TAB_CAPTURE_AUDIO") {
    startTabCaptureAudio(message)
      .then(sendResponse)
      .catch((error) => {
        console.warn(`${LOG_PREFIX} Failed to start capture:`, error);
        sendResponse({
          ok: false,
          error: error.message || "Failed to start audio capture."
        });
      });

    return true;
  }

  if (message.type === "UPDATE_WINDOW_CAPTURES") {
    updateWindowCaptures(message)
      .then(sendResponse)
      .catch((error) => {
        console.warn(`${LOG_PREFIX} Failed to update capture:`, error);
        sendResponse({
          ok: false,
          error: error.message || "Failed to update audio capture."
        });
      });

    return true;
  }

  if (message.type === "STOP_TAB_CAPTURE_AUDIO") {
    sendResponse({
      ok: true,
      stopped: stopCapture(Number(message.tabId))
    });
    return false;
  }

  if (message.type === "STOP_WINDOW_CAPTURES") {
    sendResponse({
      ok: true,
      stoppedCount: stopWindowCaptures(Number(message.windowId))
    });
    return false;
  }

  return false;
});
