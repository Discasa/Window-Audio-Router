const LOG_PREFIX = "[Window Audio Router]";

const elements = {
  windowLabel: document.getElementById("windowLabel"),
  audioOutputSelect: document.getElementById("audioOutputSelect"),
  volumeRange: document.getElementById("volumeRange"),
  volumeValue: document.getElementById("volumeValue"),
  permissionWarning: document.getElementById("permissionWarning"),
  status: document.getElementById("status")
};

let currentWindowId = null;
let savedSettings = {
  sinkId: "",
  sinkLabel: "",
  volume: 1
};
let deviceOptions = new Map();
let isInitializing = true;
let volumeApplyTimer = null;
let hasOnlyDefaultOutput = true;
let isRequestingAudioOutput = false;
let localizedMessages = null;

function shouldUseBrazilianPortuguese() {
  const languages = [
    chrome.i18n.getUILanguage(),
    navigator.language,
    ...(Array.isArray(navigator.languages) ? navigator.languages : [])
  ];

  return languages.some((language) => String(language || "").toLowerCase().startsWith("pt"));
}

async function loadLocalizedMessages() {
  if (!shouldUseBrazilianPortuguese()) {
    localizedMessages = null;
    return;
  }

  try {
    const response = await fetch(chrome.runtime.getURL("_locales/pt_BR/messages.json"));
    localizedMessages = await response.json();
  } catch (error) {
    console.info(`${LOG_PREFIX} Could not load pt-BR locale override:`, error.message);
    localizedMessages = null;
  }
}

function t(key, substitutions = []) {
  const localMessage = localizedMessages?.[key]?.message;

  if (localMessage) {
    const placeholderNames = Object.keys(localizedMessages[key].placeholders || {});

    return placeholderNames.reduce((message, placeholderName, index) => {
      const token = `$${placeholderName.toUpperCase()}$`;
      return message.replaceAll(token, substitutions[index] || "");
    }, localMessage);
  }

  const value = chrome.i18n.getMessage(key, substitutions);
  return value || key;
}

function localizeDocument() {
  document.documentElement.lang = chrome.i18n.getUILanguage().replace("_", "-");

  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
}

function getCurrentWindow() {
  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent((windowInfo) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(windowInfo);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
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

function getSelectedVolume() {
  return normalizeVolume(Number(elements.volumeRange.value) / 100);
}

function setVolumeControl(volume) {
  const normalizedVolume = normalizeVolume(volume);
  const percent = Math.round(normalizedVolume * 100);

  elements.volumeRange.value = String(percent);
  elements.volumeValue.textContent = `${percent}%`;
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status${type ? ` ${type}` : ""}`;
}

function setWarning(message) {
  elements.permissionWarning.textContent = message;
  elements.permissionWarning.hidden = !message;
}

function setBusy(isBusy) {
  elements.audioOutputSelect.disabled = isBusy;
}

function serializeDevice(device) {
  return {
    kind: device.kind || "",
    label: device.label || "",
    deviceId: device.deviceId || "",
    groupId: device.groupId || ""
  };
}

function getFriendlyDeviceLabel(device, index) {
  const label = (device.label || "").trim();

  if (label) {
    return label.replace(/^Default\s*-\s*/i, "").replace(/^Communications\s*-\s*/i, "");
  }

  return t("unnamedAudioOutput", [String(index + 1)]);
}

function getSpecificAudioOutputs(devices) {
  const seenDeviceIds = new Set();
  const outputs = [];

  devices
    .map(serializeDevice)
    .filter((device) => device.kind === "audiooutput")
    .forEach((device) => {
      if (
        !device.deviceId ||
        device.deviceId === "default" ||
        device.deviceId === "communications" ||
        seenDeviceIds.has(device.deviceId)
      ) {
        return;
      }

      seenDeviceIds.add(device.deviceId);
      outputs.push(device);
    });

  return outputs;
}

function getPreferredSinkId(preferredSinkId, preferredSinkLabel, outputs) {
  if (preferredSinkId && outputs.some((device) => device.deviceId === preferredSinkId)) {
    return preferredSinkId;
  }

  const normalizedPreferredLabel = normalizeDeviceLabel(preferredSinkLabel);

  if (normalizedPreferredLabel) {
    const matchedDevice = outputs.find(
      (device) => normalizeDeviceLabel(device.label) === normalizedPreferredLabel
    );

    if (matchedDevice) {
      return matchedDevice.deviceId;
    }
  }

  return preferredSinkId || "";
}

function setSelectOptions(devices, preferredSinkId, preferredSinkLabel = "") {
  const select = elements.audioOutputSelect;
  const outputs = getSpecificAudioOutputs(devices);
  const selectedSinkId = getPreferredSinkId(preferredSinkId, preferredSinkLabel, outputs);
  const seenDeviceIds = new Set([""]);

  deviceOptions = new Map();
  select.textContent = "";
  select.add(new Option(t("windowsDefaultOption"), ""));
  deviceOptions.set("", {
    sinkId: "",
    sinkLabel: ""
  });

  outputs.forEach((device, index) => {
    const label = getFriendlyDeviceLabel(device, index);
    seenDeviceIds.add(device.deviceId);
    deviceOptions.set(device.deviceId, {
      sinkId: device.deviceId,
      sinkLabel: label
    });
    select.add(new Option(label, device.deviceId));
  });

  if (selectedSinkId && !seenDeviceIds.has(selectedSinkId)) {
    const label = preferredSinkLabel || t("previouslySelectedOutput");
    deviceOptions.set(selectedSinkId, {
      sinkId: selectedSinkId,
      sinkLabel: preferredSinkLabel
    });
    select.add(new Option(label, selectedSinkId));
  }

  select.value = selectedSinkId || "";

  return {
    specificCount: outputs.length,
    hiddenLabelCount: outputs.filter((device) => !device.label).length
  };
}

async function loadSavedSettings() {
  const response = await sendRuntimeMessage({
    type: "GET_WINDOW_AUDIO_SETTINGS",
    windowId: currentWindowId
  });

  if (!response || response.ok === false) {
    throw new Error(response?.error || "Could not load this window's settings.");
  }

  savedSettings = {
    sinkId: typeof response.sinkId === "string" ? response.sinkId : "",
    sinkLabel: typeof response.sinkLabel === "string" ? response.sinkLabel : "",
    volume: normalizeVolume(response.volume)
  };
  elements.audioOutputSelect.value = savedSettings.sinkId;
  setVolumeControl(savedSettings.volume);
}

async function enumerateFromPopupOrigin() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    return {
      ok: false,
      outputs: [],
      error: "enumerateDevices() is not available in this popup."
    };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  return {
    ok: true,
    outputs: getSpecificAudioOutputs(devices),
    rawDevices: devices.map(serializeDevice)
  };
}

async function selectAudioOutputFromBrowser() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.selectAudioOutput !== "function") {
    throw new Error("selectAudioOutput() is not available in this browser.");
  }

  const selectedDevice = await navigator.mediaDevices.selectAudioOutput();
  return selectedDevice ? serializeDevice(selectedDevice) : null;
}

async function refreshDevices(preferredSinkId = savedSettings.sinkId) {
  setStatus(t("detectingOutputs"));

  const popupResult = await enumerateFromPopupOrigin();
  const result = setSelectOptions(popupResult.outputs || [], preferredSinkId, savedSettings.sinkLabel);
  hasOnlyDefaultOutput = result.specificCount === 0;

  if (result.specificCount === 0) {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === "function") {
      setWarning(t("outputPermissionHint"));
    } else {
      setWarning(t("outputUnavailableHint"));
    }

    setStatus(t("noRealOutputs"), "error");
    return result;
  }

  setWarning("");
  setStatus(t("outputsDetected", [String(result.specificCount)]), "success");
  return result;
}

async function requestAudioOutputFromDropdown(event) {
  if (
    isInitializing ||
    !hasOnlyDefaultOutput ||
    isRequestingAudioOutput ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.selectAudioOutput !== "function"
  ) {
    return;
  }

  event.preventDefault();
  isRequestingAudioOutput = true;
  setBusy(true);
  setStatus(t("openingOutputPicker"));

  try {
    const selectedDevice = await selectAudioOutputFromBrowser();
    const popupResult = await enumerateFromPopupOrigin();
    const outputs = popupResult.outputs || [];

    if (selectedDevice && selectedDevice.kind === "audiooutput") {
      const alreadyListed = outputs.some((device) => device.deviceId === selectedDevice.deviceId);

      if (!alreadyListed) {
        outputs.push(selectedDevice);
      }
    }

    const result = setSelectOptions(
      outputs,
      selectedDevice?.deviceId || savedSettings.sinkId,
      selectedDevice?.label || savedSettings.sinkLabel
    );
    hasOnlyDefaultOutput = result.specificCount === 0;

    if (result.specificCount === 0) {
      setStatus(t("noRealOutputs"), "error");
      return;
    }

    setWarning("");
    setStatus(t("outputsDetected", [String(result.specificCount)]), "success");
    await applySelectedSettings();
  } catch (error) {
    console.info(`${LOG_PREFIX} Output selection was denied or unavailable:`, error.message);
    setStatus(
      error.name === "NotAllowedError" ? t("permissionDenied") : t("cannotUnlockOutputs"),
      "error"
    );
  } finally {
    isRequestingAudioOutput = false;
    setBusy(false);
  }
}

function getSelectedDevice() {
  return deviceOptions.get(elements.audioOutputSelect.value) || {
    sinkId: elements.audioOutputSelect.value || "",
    sinkLabel: ""
  };
}

async function applySelectedSettings(options = {}) {
  const selectedDevice = getSelectedDevice();
  const sinkId = selectedDevice.sinkId || "";
  const sinkLabel = selectedDevice.sinkLabel || "";
  const volume = getSelectedVolume();

  try {
    if (!options.quiet) {
      setBusy(true);
      setStatus(t("applying"));
    }

    const response = await sendRuntimeMessage({
      type: "SET_WINDOW_AUDIO_SETTINGS",
      windowId: currentWindowId,
      sinkId,
      sinkLabel,
      volume
    });

    if (!response || response.ok === false) {
      throw new Error(response?.error || "Could not apply the audio output.");
    }

    savedSettings = {
      sinkId,
      sinkLabel,
      volume
    };

    const result = response.result || {};
    const captureResult = response.captureResult || null;
    const failedCount = Number.isInteger(result.failedCount) ? result.failedCount : 0;
    const label = sinkLabel || t("windowsDefaultOption");
    const percent = String(Math.round(volume * 100));

    if (captureResult && captureResult.ok) {
      setStatus(t("activeTabRoutingStatus", [label, percent]), "success");
      return;
    }

    if (sinkId && captureResult && captureResult.ok === false) {
      setStatus(t("tabCaptureFailedStatus", [label, captureResult.error || "unknown error"]), "error");
      return;
    }

    if (failedCount > 0) {
      setStatus(t("partiallyAppliedStatus", [label, percent]), "error");
      return;
    }

    setStatus(t("volumeStatus", [label, percent]), "success");
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to apply selection:`, error);
    setStatus(error.message || t("genericApplyError"), "error");
  } finally {
    if (!options.quiet) {
      setBusy(false);
    }
  }
}

function scheduleVolumeApply() {
  if (volumeApplyTimer) {
    clearTimeout(volumeApplyTimer);
  }

  volumeApplyTimer = setTimeout(() => {
    volumeApplyTimer = null;

    if (!isInitializing) {
      void applySelectedSettings({ quiet: true });
    }
  }, 120);
}

async function init() {
  try {
    await loadLocalizedMessages();
    localizeDocument();
    setBusy(true);

    const windowInfo = await getCurrentWindow();
    currentWindowId = windowInfo.id;
    elements.windowLabel.textContent = t("windowLabel", [String(currentWindowId)]);

    await loadSavedSettings();
    await refreshDevices(savedSettings.sinkId);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to initialize popup:`, error);
    setStatus(error.message || t("genericStartupError"), "error");
  } finally {
    isInitializing = false;
    setBusy(false);
  }
}

elements.audioOutputSelect.addEventListener("change", () => {
  if (!isInitializing) {
    void applySelectedSettings();
  }
});

elements.audioOutputSelect.addEventListener("pointerdown", (event) => {
  void requestAudioOutputFromDropdown(event);
});

elements.volumeRange.addEventListener("input", () => {
  setVolumeControl(getSelectedVolume());
  scheduleVolumeApply();
});

document.addEventListener("DOMContentLoaded", () => {
  void init();
});
