const SETTINGS_STORAGE_KEY = "windowAudioSettings";
const LEGACY_SINK_STORAGE_KEY = "windowSinkIds";
const LOG_PREFIX = "[Window Audio Router]";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

function normalizeSinkId(sinkId) {
  return typeof sinkId === "string" ? sinkId : "";
}

function normalizeVolume(volume, fallback = 1) {
  const parsedVolume = Number(volume);

  if (!Number.isFinite(parsedVolume)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsedVolume));
}

function normalizeWindowId(windowId) {
  const id = Number(windowId);

  if (!Number.isInteger(id) || id < 0) {
    throw new Error("Invalid windowId.");
  }

  return id;
}

function normalizeAudioSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return {
      sinkId: "",
      sinkLabel: "",
      volume: 1
    };
  }

  return {
    sinkId: normalizeSinkId(settings.sinkId),
    sinkLabel: typeof settings.sinkLabel === "string" ? settings.sinkLabel : "",
    volume: normalizeVolume(settings.volume, 1)
  };
}

function getFromStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(items);
    });
  });
}

function setInStorage(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response || { ok: true });
    });
  });
}

function executeContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: {
          tabId,
          allFrames: true
        },
        files: ["content_script.js"]
      },
      (results) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(results || []);
      }
    );
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tabs || []);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tab);
    });
  });
}

function sendExtensionMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response || { ok: true });
    });
  });
}

function getTabCaptureStreamId(options) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      if (!streamId) {
        reject(new Error("Edge did not return a tab capture stream ID."));
        return;
      }

      resolve(streamId);
    });
  });
}

async function hasOffscreenDocument() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }

  if (chrome.runtime.getContexts) {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    return contexts.length > 0;
  }

  return false;
}

let creatingOffscreenDocument = null;

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Play captured tab audio through the selected output device."
    });
  }

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function getActiveTabInWindow(windowId) {
  const tabs = await queryTabs({
    active: true,
    windowId: normalizeWindowId(windowId)
  });

  return tabs.find((tab) => Number.isInteger(tab.id)) || null;
}

async function getStorageMaps() {
  const items = await getFromStorage([SETTINGS_STORAGE_KEY, LEGACY_SINK_STORAGE_KEY]);
  const settingsMap = items[SETTINGS_STORAGE_KEY];
  const legacySinkMap = items[LEGACY_SINK_STORAGE_KEY];

  return {
    settingsMap:
      settingsMap && typeof settingsMap === "object" && !Array.isArray(settingsMap)
        ? settingsMap
        : {},
    legacySinkMap:
      legacySinkMap && typeof legacySinkMap === "object" && !Array.isArray(legacySinkMap)
        ? legacySinkMap
        : {}
  };
}

async function getWindowAudioSettings(windowId) {
  const id = normalizeWindowId(windowId);
  const key = String(id);
  const { settingsMap, legacySinkMap } = await getStorageMaps();

  if (Object.prototype.hasOwnProperty.call(settingsMap, key)) {
    return normalizeAudioSettings(settingsMap[key]);
  }

  if (Object.prototype.hasOwnProperty.call(legacySinkMap, key)) {
    return {
      sinkId: normalizeSinkId(legacySinkMap[key]),
      sinkLabel: "",
      volume: 1
    };
  }

  return undefined;
}

async function getWindowAudioSettingsOrDefault(windowId) {
  return (await getWindowAudioSettings(windowId)) || {
    sinkId: "",
    sinkLabel: "",
    volume: 1
  };
}

async function setWindowAudioSettings(windowId, settings) {
  const id = normalizeWindowId(windowId);
  const key = String(id);
  const { settingsMap } = await getStorageMaps();
  const normalizedSettings = normalizeAudioSettings(settings);

  settingsMap[key] = normalizedSettings;
  await setInStorage({ [SETTINGS_STORAGE_KEY]: settingsMap });

  return normalizedSettings;
}

async function removeWindowAudioSettings(windowId) {
  const id = normalizeWindowId(windowId);
  const key = String(id);
  const { settingsMap, legacySinkMap } = await getStorageMaps();

  delete settingsMap[key];
  delete legacySinkMap[key];

  await setInStorage({
    [SETTINGS_STORAGE_KEY]: settingsMap,
    [LEGACY_SINK_STORAGE_KEY]: legacySinkMap
  });
}

async function applyAudioSettingsToTab(tabId, settings) {
  const normalizedSettings = normalizeAudioSettings(settings);
  const message = {
    type: "APPLY_AUDIO_SETTINGS",
    sinkId: normalizedSettings.sinkId,
    sinkLabel: normalizedSettings.sinkLabel,
    volume: normalizedSettings.volume
  };

  try {
    const response = await sendMessageToTab(tabId, message);
    return {
      tabId,
      ok: response.ok !== false,
      injected: false,
      response
    };
  } catch (messageError) {
    try {
      await executeContentScript(tabId);
      const response = await sendMessageToTab(tabId, message);

      return {
        tabId,
        ok: response.ok !== false,
        injected: true,
        response
      };
    } catch (injectionError) {
      const reason = injectionError.message || messageError.message || "The tab does not accept script injection.";
      console.info(`${LOG_PREFIX} Could not apply audio settings to tab ${tabId}: ${reason}`);

      return {
        tabId,
        ok: false,
        injected: false,
        error: reason
      };
    }
  }
}

async function applyAudioSettingsToWindow(windowId, settings) {
  const id = normalizeWindowId(windowId);
  const normalizedSettings = normalizeAudioSettings(settings);
  const tabs = await queryTabs({ windowId: id });
  const eligibleTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  const results = await Promise.all(
    eligibleTabs.map((tab) => applyAudioSettingsToTab(tab.id, normalizedSettings))
  );

  const appliedCount = results.filter((result) => result.ok).length;
  const failedCount = results.length - appliedCount;

  console.info(
    `${LOG_PREFIX} Applied settings to window ${id}: ${appliedCount}/${results.length} tab(s).`
  );

  return {
    windowId: id,
    sinkId: normalizedSettings.sinkId,
    sinkLabel: normalizedSettings.sinkLabel,
    volume: normalizedSettings.volume,
    tabCount: results.length,
    appliedCount,
    failedCount,
    results
  };
}

async function stopCapturedAudioForWindow(windowId) {
  if (!(await hasOffscreenDocument())) {
    return {
      ok: true,
      stoppedCount: 0
    };
  }

  return sendExtensionMessage({
    type: "STOP_WINDOW_CAPTURES",
    windowId: normalizeWindowId(windowId)
  });
}

async function routeCapturedAudioForWindow(windowId, settings) {
  const id = normalizeWindowId(windowId);
  const normalizedSettings = normalizeAudioSettings(settings);

  if (!normalizedSettings.sinkId) {
    return stopCapturedAudioForWindow(id);
  }

  const activeTab = await getActiveTabInWindow(id);

  if (!activeTab || !Number.isInteger(activeTab.id)) {
    throw new Error("There is no active tab to capture in this window.");
  }

  if (await hasOffscreenDocument()) {
    try {
      const updateResult = await sendExtensionMessage({
        type: "UPDATE_WINDOW_CAPTURES",
        windowId: id,
        sinkId: normalizedSettings.sinkId,
        sinkLabel: normalizedSettings.sinkLabel,
        volume: normalizedSettings.volume
      });

      if (updateResult && Array.isArray(updateResult.updatedTabIds) && updateResult.updatedTabIds.length > 0) {
        if (updateResult.updatedTabIds.includes(activeTab.id)) {
          return {
            ok: true,
            mode: "tabCapture",
            updated: true,
            ...updateResult
          };
        }

        await stopCapturedAudioForWindow(id);
      }
    } catch (error) {
      console.info(`${LOG_PREFIX} Could not update existing capture:`, error.message);
    }
  }

  const streamId = await getTabCaptureStreamId({
    targetTabId: activeTab.id
  });

  await ensureOffscreenDocument();

  const startResult = await sendExtensionMessage({
    type: "START_TAB_CAPTURE_AUDIO",
    tabId: activeTab.id,
    windowId: id,
    streamId,
    sinkId: normalizedSettings.sinkId,
    sinkLabel: normalizedSettings.sinkLabel,
    volume: normalizedSettings.volume
  });

  if (!startResult || startResult.ok === false) {
    throw new Error(startResult?.error || "Could not start tab audio capture routing.");
  }

  return {
    ok: true,
    mode: "tabCapture",
    capturedTabId: activeTab.id,
    ...startResult
  };
}

async function applySavedSettingsToTab(tabId, windowId, reason) {
  try {
    const settings = await getWindowAudioSettings(windowId);

    if (!settings) {
      return;
    }

    const result = await applyAudioSettingsToTab(tabId, settings);

    if (!result.ok) {
      console.info(
        `${LOG_PREFIX} Reapply skipped for tab ${tabId} (${reason}): ${result.error || "no response"}`
      );
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to reapply saved settings:`, error);
  }
}

async function setAndApplyWindowAudioSettings(message) {
  const settings = await setWindowAudioSettings(message.windowId, {
    sinkId: message.sinkId,
    sinkLabel: message.sinkLabel,
    volume: message.volume
  });
  const result = await applyAudioSettingsToWindow(message.windowId, settings);
  let captureResult = null;

  try {
    captureResult = await routeCapturedAudioForWindow(message.windowId, settings);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Tab capture routing failed:`, error);
    captureResult = {
      ok: false,
      error: error.message || "Tab capture routing failed."
    };
  }

  return {
    ok: true,
    ...settings,
    result,
    captureResult
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "GET_WINDOW_AUDIO_SETTINGS") {
    getWindowAudioSettingsOrDefault(message.windowId)
      .then((settings) => {
        sendResponse({
          ok: true,
          ...settings
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Could not load settings."
        });
      });

    return true;
  }

  if (message.type === "GET_WINDOW_SINK_ID") {
    getWindowAudioSettingsOrDefault(message.windowId)
      .then((settings) => {
        sendResponse({
          ok: true,
          sinkId: settings.sinkId
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Could not load settings."
        });
      });

    return true;
  }

  if (message.type === "SET_WINDOW_AUDIO_SETTINGS" || message.type === "SET_WINDOW_SINK_ID") {
    setAndApplyWindowAudioSettings(message)
      .then(sendResponse)
      .catch((error) => {
        console.warn(`${LOG_PREFIX} Failed to apply window settings:`, error);
        sendResponse({
          ok: false,
          error: error.message || "Could not apply settings to this window."
        });
      });

    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !Number.isInteger(tab.windowId)) {
    return;
  }

  void applySavedSettingsToTab(tabId, tab.windowId, "tab updated");
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    return;
  }

  void applySavedSettingsToTab(tab.id, tab.windowId, "tab created");
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (!Number.isInteger(attachInfo.newWindowId)) {
    return;
  }

  void applySavedSettingsToTab(tabId, attachInfo.newWindowId, "tab moved to another window");
});

chrome.tabs.onReplaced.addListener((addedTabId) => {
  void (async () => {
    try {
      const tab = await getTab(addedTabId);

      if (Number.isInteger(tab.windowId)) {
        await applySavedSettingsToTab(addedTabId, tab.windowId, "tab replaced");
      }
    } catch (error) {
      console.info(`${LOG_PREFIX} Could not inspect replaced tab:`, error.message);
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!Number.isInteger(tabId)) {
    return;
  }

  void (async () => {
    if (!(await hasOffscreenDocument())) {
      return;
    }

    await sendExtensionMessage({
      type: "STOP_TAB_CAPTURE_AUDIO",
      tabId
    });
  })().catch((error) => {
    console.info(`${LOG_PREFIX} Could not stop capture for tab ${tabId}:`, error.message);
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void removeWindowAudioSettings(windowId).catch((error) => {
    console.warn(`${LOG_PREFIX} Could not remove settings for window ${windowId}:`, error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.info(`${LOG_PREFIX} Installed. Routing and volume target compatible HTMLMediaElement playback and captured tab audio.`);
});
