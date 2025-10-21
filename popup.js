const DEFAULT_SETTINGS = {
  showStatus: true,
  showYaps: true,
  showLeaderboard: true,
};

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        console.error("Unable to read settings:", chrome.runtime.lastError);
      }
      resolve({ ...DEFAULT_SETTINGS, ...items });
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
  const controls = Array.from(form.querySelectorAll('input[type="checkbox"]'));
  const settings = await loadSettings();

  controls.forEach((input) => {
    const key = input.name;
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      input.checked = Boolean(settings[key]);
    }
  });

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (target && target.type === "checkbox") {
      const key = target.name;
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
        saveSetting(key, target.checked);
      }
    }
  });
});
