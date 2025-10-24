const DEFAULT_SETTINGS = {
  showStatus: true,
  showYaps: true,
  showLeaderboard: true,
  autoReplyEnabled: true,
  autoScrollEnabled: true,
  autoScrollDelayMs: 3500,
  minSmartFollowers: 0,
  minTotalYaps: 0,
  leaderboardProjectFilter: "",
};

const AUTO_SCROLL_DELAY_MIN = 500;
const AUTO_SCROLL_DELAY_MAX = 60000;

function sanitizeNumberSetting(key, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_SETTINGS[key];
  if (key === "autoScrollDelayMs") {
    const clamped = Math.min(Math.max(num, AUTO_SCROLL_DELAY_MIN), AUTO_SCROLL_DELAY_MAX);
    const rounded = Math.round(clamped / 100) * 100;
    return Math.min(Math.max(rounded, AUTO_SCROLL_DELAY_MIN), AUTO_SCROLL_DELAY_MAX);
  }
  if (key === "minSmartFollowers" || key === "minTotalYaps") {
    return Math.max(Math.floor(num), 0);
  }
  return num;
}

function sanitizeStringSetting(key, value) {
  if (typeof value !== "string") return DEFAULT_SETTINGS[key];
  const trimmed = value.trim();
  return trimmed.length ? trimmed : "";
}

function resolveSettingValue(key, rawValue) {
  switch (key) {
    case "showStatus":
    case "showYaps":
    case "showLeaderboard":
    case "autoReplyEnabled":
    case "autoScrollEnabled":
      return rawValue === undefined ? DEFAULT_SETTINGS[key] : Boolean(rawValue);
    case "autoScrollDelayMs":
      return sanitizeNumberSetting(key, rawValue);
    case "minSmartFollowers":
    case "minTotalYaps":
      return sanitizeNumberSetting(key, rawValue);
    case "leaderboardProjectFilter":
      return sanitizeStringSetting(key, rawValue);
    default:
      return rawValue === undefined ? DEFAULT_SETTINGS[key] : rawValue;
  }
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        console.error("Unable to read settings:", chrome.runtime.lastError);
      }
      const merged = { ...DEFAULT_SETTINGS };
      Object.keys(DEFAULT_SETTINGS).forEach((key) => {
        merged[key] = resolveSettingValue(key, items[key]);
      });
      resolve(merged);
    });
  });
}

function saveSetting(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error("Unable to save setting:", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("settings-form");
  const inputs = Array.from(form.querySelectorAll("input[name]"));
  const settings = await loadSettings();

  inputs.forEach((input) => {
    const key = input.name;
    if (!Object.prototype.hasOwnProperty.call(settings, key)) return;
    if (input.type === "checkbox") {
      input.checked = Boolean(settings[key]);
    } else if (input.type === "number") {
      input.value = sanitizeNumberSetting(key, settings[key]);
    } else if (input.type === "text") {
      input.value = sanitizeStringSetting(key, settings[key]);
    }
  });

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.name;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;

    if (target.type === "checkbox") {
      saveSetting(key, target.checked);
    } else if (target.type === "number") {
      const value = sanitizeNumberSetting(key, target.value);
      target.value = value;
      saveSetting(key, value);
    } else if (target.type === "text") {
      const value = sanitizeStringSetting(key, target.value);
      target.value = value;
      saveSetting(key, value);
    }
  });
});
