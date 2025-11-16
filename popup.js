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
  projectYappingList: [],
};

const AUTO_SCROLL_DELAY_MIN = 500;
const AUTO_SCROLL_DELAY_MAX = 60000;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const POPUP_DEFAULT_TAB = "projects";
const KAITO_LEADERBOARD_ENDPOINT = "https://gomtu.xyz/api/kaito/leaderboard";

function generateProjectId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `project-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getTodayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function sanitizeProjectEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const account = typeof entry.account === "string" ? entry.account.trim() : "";
  const keyword = typeof entry.keyword === "string" ? entry.keyword.trim() : "";
  const lastCheckedDate =
    typeof entry.lastCheckedDate === "string" && DATE_KEY_PATTERN.test(entry.lastCheckedDate)
      ? entry.lastCheckedDate
      : null;

  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id : generateProjectId(),
    name,
    account,
    keyword,
    lastCheckedDate,
  };
}

function sanitizeProjectYappingList(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return rawValue
    .map((entry) => sanitizeProjectEntry(entry))
    .filter((entry) => Boolean(entry));
}

function normalizeAccountUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@/, "");
  if (!handle) return "";
  return `https://x.com/${handle}`;
}

function buildSearchUrl(keyword) {
  if (!keyword) return "";
  const encoded = encodeURIComponent(keyword);
  return `https://x.com/search?q=${encoded}&src=typed_query&f=live`;
}

function openExternalUrl(url) {
  if (!url) return;
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function fetchCatalogDirect() {
  const res = await fetch(KAITO_LEADERBOARD_ENDPOINT, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Gagal memuat catalog langsung (HTTP ${res.status})`);
  }
  const payload = await res.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

function sendCatalogRequest(forceRefresh = false) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error("Runtime messaging tidak tersedia"));
      return;
    }
    chrome.runtime.sendMessage(
      { type: "FETCH_LEADERBOARD_CATALOG", forceRefresh },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("Tidak ada respons catalog"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || "Gagal memuat catalog"));
          return;
        }
        resolve(Array.isArray(response.data) ? response.data : []);
      },
    );
  });
}

async function requestLeaderboardCatalog(forceRefresh = false) {
  if (!chrome?.runtime?.sendMessage) {
    return fetchCatalogDirect();
  }

  try {
    return await sendCatalogRequest(forceRefresh);
  } catch (error) {
    const fallbackErrors = ["message port closed", "receiving end does not exist"];
    const message = String(error?.message || "").toLowerCase();
    const shouldFallback = fallbackErrors.some((text) => message.includes(text));
    if (!shouldFallback) throw error;
    console.warn("Catalog via background gagal, fallback fetch langsung:", error);
    return fetchCatalogDirect();
  }
}

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
    case "projectYappingList":
      return sanitizeProjectYappingList(rawValue);
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

function initPopupTabs(defaultTab = POPUP_DEFAULT_TAB) {
  const tabButtons = Array.from(document.querySelectorAll("[data-tab-target]"));
  if (!tabButtons.length) return;

  const panels = new Map();
  tabButtons.forEach((button) => {
    const target = button.dataset.tabTarget;
    if (!target) return;
    const panel = document.querySelector(`[data-tab-panel='${target}']`);
    if (panel) panels.set(target, panel);
  });

  if (!panels.size) return;

  const initialTab = panels.has(defaultTab) ? defaultTab : tabButtons[0]?.dataset.tabTarget;
  if (!initialTab) return;

  function activateTab(tabName) {
    if (!panels.has(tabName)) return;
    tabButtons.forEach((button) => {
      const target = button.dataset.tabTarget;
      const isActive = target === tabName;
      button.classList.toggle("tabs__button--active", isActive);
      if (button.hasAttribute("aria-selected")) {
        button.setAttribute("aria-selected", String(isActive));
      }
    });

    panels.forEach((panel, key) => {
      const isActive = key === tabName;
      panel.classList.toggle("tab-panel--active", isActive);
      panel.setAttribute("aria-hidden", String(!isActive));
    });
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tabTarget;
      if (target) activateTab(target);
    });
  });

  activateTab(initialTab);
}

document.addEventListener("DOMContentLoaded", async () => {
  initPopupTabs();

  const settings = await loadSettings();
  const form = document.getElementById("settings-form");
  const inputs = form ? Array.from(form.querySelectorAll("input[name]")) : [];

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

  form?.addEventListener("change", (event) => {
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

  initProjectYapping(settings.projectYappingList);
});

function initProjectYapping(initialProjects) {
  const listContainer = document.getElementById("project-yapping-list");
  const openDialogBtn = document.getElementById("open-project-dialog");
  const dialog = document.getElementById("project-dialog");
  const manualForm = document.getElementById("project-manual-form");
  const nameInput = document.getElementById("project-name-input");
  const accountInput = document.getElementById("project-account-input");
  const keywordInput = document.getElementById("project-keyword-input");
  const formHint = document.getElementById("project-form-hint");
  const catalogList = document.getElementById("catalog-list");
  const catalogStatus = document.getElementById("catalog-status");
  const catalogSearch = document.getElementById("catalog-search");
  const refreshCatalogBtn = document.getElementById("refresh-catalog");
  const dialogBody = dialog?.querySelector(".project-dialog__body");
  const dialogCloseButtons = dialog ? Array.from(dialog.querySelectorAll("[data-dialog-close]")) : [];

  if (
    !listContainer ||
    !openDialogBtn ||
    !dialog ||
    !manualForm ||
    !nameInput ||
    !accountInput ||
    !keywordInput
  ) {
    return;
  }

  let projects = sanitizeProjectYappingList(initialProjects);
  let catalogEntries = [];
  let catalogLoading = false;
  let catalogLoaded = false;

  renderProjects();

  openDialogBtn.addEventListener("click", () => {
    openDialog();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  dialogCloseButtons.forEach((button) => {
    button.addEventListener("click", () => closeDialog());
  });

  manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = sanitizeProjectEntry({
      name: nameInput.value,
      account: accountInput.value,
      keyword: keywordInput.value,
      lastCheckedDate: null,
    });
    if (!entry) {
      setFormHint("Nama project wajib diisi.");
      nameInput.focus();
      return;
    }
    commitProjects([
      ...projects,
      {
        ...entry,
        lastCheckedDate: null,
      },
    ]);
    closeDialog();
  });

  catalogSearch?.addEventListener("input", () => renderCatalogList());
  refreshCatalogBtn?.addEventListener("click", () => ensureCatalogLoaded(true));

  function openDialog() {
    if (!dialog.open) dialog.showModal();
    manualForm.reset();
    setFormHint("");
    nameInput.focus();
    if (dialogBody) dialogBody.scrollTop = 0;
    ensureCatalogLoaded();
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    manualForm.reset();
    setFormHint("");
  }

  function setFormHint(message = "") {
    if (formHint) {
      formHint.textContent = message;
    }
  }

  function updateCatalogStatus(message = "") {
    if (catalogStatus) {
      catalogStatus.textContent = message;
    }
  }

  function commitProjects(nextProjects) {
    projects = sanitizeProjectYappingList(nextProjects);
    renderProjects();
    saveSetting("projectYappingList", projects);
  }

  function renderProjects() {
    listContainer.innerHTML = "";
    if (!projects.length) {
      const empty = document.createElement("p");
      empty.className = "yapping__empty";
      empty.textContent = "Belum ada project. Klik Tambah Project.";
      listContainer.appendChild(empty);
      return;
    }

    projects.forEach((project) => {
      listContainer.appendChild(createProjectCard(project));
    });
  }

  function createProjectCard(project) {
    const item = document.createElement("div");
    item.className = "yapping-project";
    item.dataset.projectId = project.id;

    const header = document.createElement("div");
    header.className = "yapping-project__header";

    const nameEl = document.createElement("p");
    nameEl.className = "yapping-project__name";
    nameEl.textContent = project.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "yapping-project__remove";
    removeBtn.textContent = "Hapus";
    removeBtn.addEventListener("click", () => {
      commitProjects(projects.filter((entry) => entry.id !== project.id));
    });

    header.append(nameEl, removeBtn);

    const checkLabel = document.createElement("label");
    checkLabel.className = "yapping-project__check";
    checkLabel.htmlFor = `${project.id}-checkbox`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `${project.id}-checkbox`;
    checkbox.className = "yapping-project__checkbox";
    const todayKey = getTodayKey();
    checkbox.checked = project.lastCheckedDate === todayKey;

    const checkText = document.createElement("span");
    checkText.textContent = "Checklist harian";

    const status = document.createElement("span");
    status.className = "yapping-project__status";
    status.textContent = checkbox.checked ? "Sudah yap" : "Belum yap";

    checkbox.addEventListener("change", () => {
      const isChecked = checkbox.checked;
      status.textContent = isChecked ? "Sudah yap" : "Belum yap";
      commitProjects(
        projects.map((entry) =>
          entry.id === project.id
            ? {
                ...entry,
                lastCheckedDate: isChecked ? getTodayKey() : null,
              }
            : entry,
        ),
      );
    });

    checkLabel.append(checkbox, checkText, status);

    const actions = document.createElement("div");
    actions.className = "yapping-project__actions";

    const accountUrl = normalizeAccountUrl(project.account);
    const accountBtn = document.createElement("button");
    accountBtn.type = "button";
    accountBtn.className = "yapping-project__action";
    accountBtn.textContent = "Akun utama";
    accountBtn.disabled = !accountUrl;
    if (accountUrl) {
      accountBtn.addEventListener("click", () => openExternalUrl(accountUrl));
    } else {
      accountBtn.title = "Isi akun utama untuk mengaktifkan tombol";
    }

    const keyword = project.keyword || project.name;
    const searchUrl = buildSearchUrl(keyword);
    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "yapping-project__action";
    searchBtn.textContent = "Cari di X";
    searchBtn.disabled = !searchUrl;
    if (searchUrl) {
      searchBtn.addEventListener("click", () => openExternalUrl(searchUrl));
    }

    actions.append(accountBtn, searchBtn);

    item.append(header, checkLabel, actions);
    return item;
  }

  async function ensureCatalogLoaded(force = false) {
    if (!catalogList) return;
    if (catalogLoading) return;
    if (!force && catalogLoaded) {
      renderCatalogList();
      return;
    }
    catalogLoading = true;
    updateCatalogStatus("Memuat catalog...");
    catalogList.innerHTML = "";
    try {
      catalogEntries = await requestLeaderboardCatalog(force);
      catalogLoaded = true;
      renderCatalogList();
      updateCatalogStatus(
        catalogEntries.length ? "Pilih project untuk mengisi form." : "Catalog kosong untuk sekarang.",
      );
    } catch (error) {
      updateCatalogStatus(`Gagal memuat catalog: ${error.message}`);
    } finally {
      catalogLoading = false;
    }
  }

  function renderCatalogList() {
    if (!catalogList) return;
    catalogList.innerHTML = "";
    const keyword = (catalogSearch?.value || "").trim().toLowerCase();
    const filtered = !keyword
      ? catalogEntries
      : catalogEntries.filter((entry) => {
          const name = (entry?.name || "").toLowerCase();
          const ticker = (entry?.ticker || "").toLowerCase();
          return name.includes(keyword) || ticker.includes(keyword);
        });

    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "yapping__empty";
      empty.textContent = catalogEntries.length
        ? "Tidak ada hasil untuk kata kunci tersebut."
        : "Catalog belum dimuat.";
      catalogList.appendChild(empty);
      return;
    }

    filtered.slice(0, 60).forEach((entry) => {
      const item = document.createElement("div");
      item.className = "catalog-item";

      const meta = document.createElement("div");
      meta.className = "catalog-item__meta";

      const nameEl = document.createElement("p");
      nameEl.className = "catalog-item__name";
      nameEl.textContent = entry?.name || entry?.ticker || "Tanpa nama";

      const tickerEl = document.createElement("span");
      tickerEl.className = "catalog-item__ticker";
      const ticker = entry?.ticker ? entry.ticker.toUpperCase() : "";
      tickerEl.textContent = ticker
        ? `${ticker}${entry?.category ? ` • ${entry.category}` : ""}`
        : entry?.category || "";

      meta.append(nameEl, tickerEl);

      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "catalog-item__use";
      useBtn.textContent = "Gunakan";
      useBtn.addEventListener("click", () => {
        applyCatalogEntry(entry);
      });

      item.append(meta, useBtn);
      catalogList.appendChild(item);
    });
  }

  function applyCatalogEntry(entry) {
    if (!entry) return;
    nameInput.value = entry.name || entry.ticker || "";
    keywordInput.value = entry.ticker || entry.name || "";
    accountInput.value = "";
    setFormHint("Nama & keyword sudah diisi, lengkapi akun sebelum simpan.");
    updateCatalogStatus("Project sudah diisi ke form manual di atas.");
    if (dialogBody) dialogBody.scrollTop = 0;
    nameInput.focus();
  }
}
