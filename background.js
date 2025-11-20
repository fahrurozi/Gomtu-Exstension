const CACHE_TTL = 1000 * 60 * 5; // 5 menit
const cache = new Map();
const LEADERBOARD_CATALOG_CACHE_KEY = "leaderboardCatalog";
const GROK_CONVERSATIONS_ENDPOINT = "https://grok.com/rest/app-chat/conversations";
const GROK_BASE_PAGE = "https://grok.com/c";
const GROK_DEFAULT_MODEL = "grok-3-auto";
const GROK_MAX_TWEET_LENGTH = 280;
const GROK_CONTEXT_TTL = 1000 * 60 * 15;
const GROK_ANTIBOT_MESSAGE = "request rejected by anti-bot rules";
const GROK_OPEN_WITH_PROMPT = "GROK_OPEN_WITH_PROMPT";
const STORAGE_DEFAULTS = {
  grokProxyUrl: "",
};

let grokContext = null;
let activeProxyPac = null;
let cachedGrokTabId = null;

if (chrome?.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === cachedGrokTabId) {
      cachedGrokTabId = null;
    }
  });
}

chrome.storage.local.get(STORAGE_DEFAULTS, (items) => {
  applyGrokProxySetting(items.grokProxyUrl || "");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "grokProxyUrl")) {
    applyGrokProxySetting(changes.grokProxyUrl.newValue || "");
  }
});

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", mode: "cors" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchGomtu(username) {
  return fetchJson(`https://gomtu.xyz/api/yap/open?username=${encodeURIComponent(username)}`);
}

async function fetchKaitoStatus(username) {
  return fetchJson(`https://gomtu.xyz/api/kaito/user_status?username=${encodeURIComponent(username)}`);
}

async function fetchKaitoLeaderboardSearch(username) {
  return fetchJson(`https://gomtu.xyz/api/kaito/leaderboard-search?username=${encodeURIComponent(username)}`);
}

async function fetchKaitoLeaderboardCatalog() {
  return fetchJson("https://gomtu.xyz/api/kaito/leaderboard");
}

async function getLeaderboardCatalog(forceRefresh = false) {
  const cacheEntry = cache.get(LEADERBOARD_CATALOG_CACHE_KEY);
  const now = Date.now();
  if (!forceRefresh && cacheEntry && now - cacheEntry.t < CACHE_TTL) {
    return cacheEntry.data;
  }

  const result = await fetchKaitoLeaderboardCatalog();
  const items = Array.isArray(result?.data) ? result.data : [];
  cache.set(LEADERBOARD_CATALOG_CACHE_KEY, { data: items, t: now });
  return items;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "FETCH_LEADERBOARD_CATALOG") {
    (async () => {
      try {
        const catalog = await getLeaderboardCatalog(Boolean(msg.forceRefresh));
        sendResponse({ ok: true, data: catalog });
      } catch (error) {
        console.error("Failed to fetch leaderboard catalog:", error);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (msg.type === "GROK_GENERATE_TWEET") {
    if (!msg.project) {
      sendResponse({ ok: false, error: "Payload project kosong." });
      return true;
    }
    (async () => {
      try {
        const tweet = await requestGrokTweetDraft(msg.project);
        sendResponse({ ok: true, data: tweet });
      } catch (error) {
        console.error("Failed to generate Grok tweet:", error);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (msg.type === "GET_SCORE" && msg.username) {
    (async () => {
      const key = msg.username.toLowerCase();
      const now = Date.now();

      const entry = cache.get(key);
      if (entry && now - entry.t < CACHE_TTL) {
        console.log(`Data for ${key} retrieved from cache.`);
        sendResponse({ ok: true, data: entry.data, fromCache: true });
        return;
      }

      try {
        const [yapsResult, statusResult, searchResult] = await Promise.allSettled([
          fetchGomtu(key),
          fetchKaitoStatus(key),
          fetchKaitoLeaderboardSearch(key),
        ]);

        if (yapsResult.status !== "fulfilled") {
          throw yapsResult.reason || new Error("Unable to fetch yaps data");
        }

        const payload = {
          yaps: yapsResult.value?.data || yapsResult.value || null,
          status: null,
        };

        if (statusResult.status === "fulfilled") {
          payload.status = statusResult.value?.data || statusResult.value || null;
        } else if (statusResult.reason) {
          console.warn(`Kaito status fetch failed for ${key}:`, statusResult.reason);
        }

        let leaderboardEntries = [];
        if (searchResult.status === "fulfilled") {
          leaderboardEntries = Array.isArray(searchResult.value?.data) ? searchResult.value.data : [];
        } else if (searchResult.reason) {
          console.warn(`Kaito leaderboard search failed for ${key}:`, searchResult.reason);
        }

        if (leaderboardEntries.length) {
          const missingTickers = new Set();
          const normalized = (value) => (value ? String(value).toUpperCase() : "");

          for (const entry of leaderboardEntries) {
            if (!entry) continue;
            const ticker = normalized(entry.topic_id ?? entry.topic?.ticker);
            if (!ticker) continue;
            if (!cache.has(`leaderboard:${ticker}`)) {
              missingTickers.add(ticker);
            }
          }

          if (missingTickers.size) {
            try {
              const catalog = await fetchKaitoLeaderboardCatalog();
              const catalogItems = Array.isArray(catalog?.data) ? catalog.data : [];
              catalogItems.forEach((item) => {
                const ticker = normalized(item?.ticker);
                if (ticker) {
                  cache.set(`leaderboard:${ticker}`, {
                    data: item,
                    t: Date.now(),
                  });
                }
              });
            } catch (err) {
              console.warn("Failed to refresh leaderboard catalog:", err);
            }
          }

          payload.leaderboard = leaderboardEntries.map((entry) => {
            const ticker = normalized(entry.topic_id ?? entry.topic?.ticker);
            const cachedTopic = ticker ? cache.get(`leaderboard:${ticker}`) : null;
            return {
              ...entry,
              topic: cachedTopic?.data || null,
            };
          });
        }

        cache.set(key, { data: payload, t: now });
        console.log(`Data for ${key} fetched from API and cache updated.`);
        sendResponse({ ok: true, data: payload, fromCache: false });
      } catch (e) {
        console.error("Gomtu fetch error:", e);
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true; // async response
  }

  if (msg.type === GROK_OPEN_WITH_PROMPT) {
    Promise.resolve()
      .then(() => {
        const project = sanitizeProjectPayload(msg.project);
        const prompt = buildGrokPrompt(project);
        return openGrokTabWithPrompt(prompt);
      })
      .then(() => {
        sendResponse({ ok: true, message: "Prompt disisipkan di tab Grok." });
      })
      .catch((error) => {
        console.error("Failed to open Grok with prompt:", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }
});

if (chrome?.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn("Unable to set side panel behavior:", err);
  });
} else {
  chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  });
}

async function requestGrokTweetDraft(project) {
  const sanitizedProject = sanitizeProjectPayload(project);
  await assertXCookies();
  await assertGrokCookies();
  const context = await ensureGrokContext();
  const prompt = buildGrokPrompt(sanitizedProject);
  const result = await startGrokConversation(prompt, context);
  const text = truncateTweet(result?.message || result?.tokens?.join("") || "");
  if (!text) {
    throw new Error("Grok tidak mengembalikan teks apa pun.");
  }
  return {
    text,
    conversationId: result?.conversationId || null,
    responseId: result?.responseId || null,
  };
}

function sanitizeProjectPayload(project) {
  if (!project || typeof project !== "object") {
    throw new Error("Project tidak valid.");
  }
  const name = typeof project.name === "string" ? project.name.trim() : "";
  if (!name) throw new Error("Nama project kosong.");
  const account = typeof project.account === "string" ? project.account.trim() : "";
  const keyword = typeof project.keyword === "string" ? project.keyword.trim() : "";
  return {
    id: typeof project.id === "string" ? project.id : null,
    name,
    account,
    keyword,
    accountUrl: buildAccountUrl(account),
  };
}

async function assertXCookies() {
  const cookies = await getCookiesByDomain(["x.com", ".x.com"]);
  const authCookie = cookies.find((cookie) => cookie.name === "auth_token");
  if (!authCookie) {
    throw new Error("auth_token X tidak ditemukan. Pastikan sudah login di X.");
  }
}

async function assertGrokCookies() {
  const cookies = await getCookiesByDomain(["grok.com", ".grok.com"]);
  if (!cookies.length) {
    throw new Error("Cookie Grok tidak ditemukan. Buka https://grok.com/c dan login terlebih dahulu.");
  }
}

function getCookiesByDomain(domains) {
  const domainList = Array.isArray(domains) ? domains : [domains];
  const readers = domainList
    .map((domain) => {
      if (!domain) return null;
      return new Promise((resolve) => {
        chrome.cookies.getAll({ domain }, (cookies) => {
          if (chrome.runtime.lastError) {
            console.warn("Unable to read cookies:", chrome.runtime.lastError);
            resolve([]);
            return;
          }
          resolve(Array.isArray(cookies) ? cookies : []);
        });
      });
    })
    .filter(Boolean);

  if (!readers.length) return Promise.resolve([]);
  return Promise.all(readers).then((chunks) => chunks.flat());
}

function buildGrokPrompt(project) {
  if (!project || typeof project !== "object") return "";
  const name = typeof project.name === "string" ? project.name.trim() : "";
  if (!name) return "";
  const account = typeof project.account === "string" ? project.account.trim() : "";
  const accountUrl = account;
  const keyword = typeof project.keyword === "string" ? project.keyword.trim() : "";

  const lines = [
    `You are a real crypto user posting naturally on Twitter, acting as the social media manager for project "${name}".`,

    "CONTEXT:",
    `- Project: ${name}`,
    `- Account: ${account || "None"}`,
    `- Focus: ${keyword || "General update"}`,
    `- X Link: ${accountUrl || "None"}`,

    "REQUIREMENTS:",
    "1. Write exactly ONE tweet in English (max 280 characters)",
    "2. Tone: confident, optimistic, human — never robotic",
    "3. Content must feel relevant to current crypto/CT narratives, trends, or sentiment",
    "4. Keep wording concise with natural human flow",
    "5. Include:",
    "   - A short CTA",
    "   - 1–2 truly relevant hashtags",
    "   - Project X link (if available)",

    "OPTIONAL (ONLY if it fits naturally):",
    "- If a recent CT tweet or a tweet from the project account relates to today’s focus, you may include the direct tweet URL (not profile). Only add it if it strengthens the message.",

    "HUMAN WRITING PATTERNS:",
    "- Allow natural punctuation variations (..., !!, ??)",
    "- Use occasional contractions (it's, you're, don't)",
    "- Keep phrasing casual but not unprofessional",
    `- Mention ${account || "the project account"} only if it fits naturally (never force it)`,

    "CRITICAL RULES:",
    "- Do NOT acknowledge being AI",
    "- No meta commentary or explanations",
    "- Avoid hypey nonsense or generic filler",
    `- Stay focused on the project and today's context: ${keyword || "(none)"}`,
    "- Output ONLY the final tweet text — no quotes, no markdown, no analysis"
  ];

  return lines.join(" ");
}

function buildAccountUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const val = raw.trim();
  if (!val) return "";
  if (/^https?:\/\//i.test(val)) return val;
  const handle = val.replace(/^@/, "");
  return handle ? `https://x.com/${handle}` : "";
}

async function ensureGrokContext(force = false) {
  if (!force && grokContext && Date.now() - grokContext.t < GROK_CONTEXT_TTL) {
    return grokContext;
  }
  const response = await fetch(GROK_BASE_PAGE, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    mode: "cors",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "sec-ch-ua": '"Chromium";v="120", "Not A(Brand";v="24", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gagal memuat halaman Grok (HTTP ${response.status})`);
  }
  const baggage = extractMetaContent(text, "baggage");
  const sentryTrace = extractMetaContent(text, "sentry-trace");
  grokContext = {
    baggage,
    sentryTrace,
    t: Date.now(),
  };
  return grokContext;
}

function extractMetaContent(html, name) {
  if (!html || !name) return null;
  const regex = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
  const match = html.match(regex);
  return match ? match[1] : null;
}

async function startGrokConversation(prompt, context) {
  const payload = {
    temporary: false,
    modelName: GROK_DEFAULT_MODEL,
    message: prompt,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: false,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: false,
    forceConcise: true,
    toolOverrides: {},
    enableSideBySide: false,
    sendFinalMetadata: true,
    isReasoning: false,
    webpageUrls: [],
    disableTextFollowUps: false,
    responseMetadata: {
      requestModelDetails: {
        modelId: GROK_DEFAULT_MODEL,
      },
    },
    disableMemory: true,
    forceSideBySide: false,
    modelMode: "MODEL_MODE_AUTO",
    isAsyncChat: false,
  };

  const res = await fetch(`${GROK_CONVERSATIONS_ENDPOINT}/new`, {
    method: "POST",
    credentials: "include",
    mode: "cors",
    cache: "no-store",
    headers: buildGrokHeaders(context),
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    const normalized = text.toLowerCase();
    const shouldRetryViaTab = res.status === 403 && normalized.includes(GROK_ANTIBOT_MESSAGE);
    if (shouldRetryViaTab) {
      console.warn("Grok 403 anti-bot detected, retrying via page context.");
      const fallback = await startGrokConversationViaTab(payload, context);
      if (fallback) return fallback;
    }
    throw new Error(`HTTP ${res.status} Grok: ${text.slice(0, 120)}`);
  }
  return parseGrokStreamPayload(text);
}

function buildGrokHeaders(context) {
  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://grok.com",
    referer: GROK_BASE_PAGE,
    pragma: "no-cache",
    "cache-control": "no-cache",
    "x-xai-request-id": generateRequestId("xai"),
    "sec-ch-ua": '"Chromium";v="120", "Not A(Brand";v="24", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (context?.baggage) {
    headers.baggage = context.baggage;
  }
  if (context?.sentryTrace) {
    headers["sentry-trace"] = `${context.sentryTrace}-${generateRequestId("trace").replace(/-/g, "").slice(0, 16)}-0`;
  };
  return headers;
}

async function startGrokConversationViaTab(payload, context) {
  if (!chrome?.tabs || !chrome?.scripting?.executeScript) {
    console.warn("Chrome tabs/scripting APIs unavailable for Grok fallback.");
    return null;
  }

  try {
    const { tab } = await ensureGrokTabReady();
    if (!tab?.id) {
      console.warn("No Grok tab available for fallback.");
      return null;
    }

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [
        `${GROK_CONVERSATIONS_ENDPOINT}/new`,
        payload,
        {
          baggage: context?.baggage || null,
          sentryTrace: context?.sentryTrace || null,
        },
        GROK_BASE_PAGE,
      ],
      func: async (endpoint, body, traceHeaders, basePage) => {
        try {
          const headers = {
            accept: "*/*",
            "content-type": "application/json",
          };
          if (traceHeaders?.baggage) headers.baggage = traceHeaders.baggage;
          if (traceHeaders?.sentryTrace) headers["sentry-trace"] = traceHeaders.sentryTrace;
          if (basePage) {
            headers.origin = new URL(basePage).origin;
            headers.referer = basePage;
          }
          const response = await fetch(endpoint, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers,
            body: JSON.stringify(body),
          });
          const text = await response.text();
          return { ok: response.ok, status: response.status, text };
        } catch (error) {
          return { ok: false, error: error?.message || String(error) };
        }
      },
    });

    const payloadResult = result?.result;
    if (!payloadResult) return null;
    if (!payloadResult.ok) {
      console.warn("Grok fallback via tab failed:", payloadResult.error || payloadResult.status);
      return null;
    }
    return parseGrokStreamPayload(payloadResult.text || "");
  } catch (error) {
    console.warn("Unable to run Grok fallback via tab:", error);
    return null;
  }
}

async function ensureGrokTabReady(options = {}) {
  const { activate = false, waitAfterLoadMs = 0 } = options;
  const existing = await findExistingGrokTab();
  const created = !existing;
  const tab = existing || (await openGrokTab({ active: activate }));
  if (!tab?.id) return { tab: null, created: false };
  cachedGrokTabId = tab.id;
  if (activate && chrome?.tabs?.update) {
    try {
      await new Promise((resolve) => {
        chrome.tabs.update(tab.id, { active: true }, () => resolve());
      });
    } catch (error) {
      console.warn("Failed to activate Grok tab:", error);
    }
  }
  if (tab.status !== "complete") {
    await waitForTabComplete(tab.id).catch(() => { });
  }
  if (waitAfterLoadMs > 0) {
    await wait(waitAfterLoadMs);
  }
  const resolvedTab = await getTabById(tab.id);
  return { tab: resolvedTab, created };
}

function findExistingGrokTab() {
  if (!chrome?.tabs?.query) return Promise.resolve(null);
  if (cachedGrokTabId) {
    return getTabById(cachedGrokTabId).then((tab) => tab || queryGrokTabs().then((tabs) => tabs[0] || null));
  }
  return queryGrokTabs().then((tabs) => tabs[0] || null);
}

function queryGrokTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://grok.com/*" }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to query Grok tabs:", chrome.runtime.lastError);
        resolve([]);
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function openGrokTab(options = {}) {
  const { active = false } = options;
  if (!chrome?.tabs?.create) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.create({ url: GROK_BASE_PAGE, active }, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to open Grok tab:", chrome.runtime.lastError);
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!chrome?.tabs?.onUpdated) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Tab Grok tidak selesai dimuat dalam batas waktu."));
    }, timeout);

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        cleanup();
        resolve(true);
      }
    };

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function getTabById(tabId) {
  if (!chrome?.tabs?.get || typeof tabId !== "number") return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openGrokTabWithPrompt(prompt) {
  if (!prompt) throw new Error("Prompt kosong.");
  const { tab } = await ensureGrokTabReady({ activate: true, waitAfterLoadMs: 700 });
  if (!tab?.id) throw new Error("Tab Grok tidak tersedia.");
  if (!chrome?.scripting?.executeScript) throw new Error("Scripting API tidak tersedia.");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [prompt],
    func: async (text) => {
      const applyToElement = (el) => {
        if (!el) return false;
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.focus();
          return true;
        }
        if (el.isContentEditable) {
          el.textContent = "";
          el.innerText = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.focus();
          return true;
        }
        return false;
      };

      const candidates = [
        "textarea",
        "div[contenteditable='true']",
        "section[contenteditable='true']",
        "[role='textbox']",
      ];
      for (const selector of candidates) {
        const el = document.querySelector(selector);
        if (applyToElement(el)) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return { ok: true, filled: true };
        }
      }

      return { ok: false, filled: false, error: "Bidang input Grok tidak ditemukan." };
    },
  });

  const payload = result?.result;
  if (!payload?.ok || !payload?.filled) {
    const message = payload?.error || "Gagal menyisipkan prompt ke tab Grok.";
    throw new Error(message);
  }
  return true;
}

function parseGrokStreamPayload(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length);

  const tokens = [];
  let message = "";
  let conversationId = null;
  let responseId = null;

  for (const line of lines) {
    const data = safeJsonParse(line);
    if (!data || typeof data !== "object") continue;

    const responseRoot = data.result?.response || data.result;
    const conversationRoot = data.result?.conversation || data.conversation;
    const modelResponse =
      responseRoot?.modelResponse || responseRoot?.response || data.result?.modelResponse;

    const token =
      responseRoot?.token ||
      modelResponse?.token ||
      data.result?.token ||
      modelResponse?.result?.token;
    if (token && typeof token === "string") tokens.push(token);

    if (!message) {
      const msg =
        modelResponse?.message ||
        responseRoot?.message ||
        data.result?.response?.modelResponse?.message;
      if (typeof msg === "string" && msg.trim()) {
        message = msg.trim();
      }
    }

    if (!conversationId) {
      conversationId =
        conversationRoot?.conversationId ||
        data.result?.conversationId ||
        data.conversationId ||
        null;
    }

    if (!responseId) {
      responseId =
        modelResponse?.responseId ||
        responseRoot?.responseId ||
        data.result?.response?.modelResponse?.responseId ||
        null;
    }
  }

  return {
    message,
    tokens,
    conversationId,
    responseId,
  };
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function truncateTweet(text) {
  if (!text) return "";
  if (text.length <= GROK_MAX_TWEET_LENGTH) return text;
  return `${text.slice(0, GROK_MAX_TWEET_LENGTH - 1).trimEnd()}…`;
}

function generateRequestId(prefix = "req") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function applyGrokProxySetting(rawUrl) {
  if (typeof chrome?.proxy?.settings === "undefined") {
    console.warn("Proxy API tidak tersedia.");
    return;
  }
  const proxyRule = buildProxyRule(rawUrl);
  if (!proxyRule) {
    if (!activeProxyPac) return;
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      activeProxyPac = null;
      if (chrome.runtime.lastError) {
        console.warn("Gagal menghapus proxy Grok:", chrome.runtime.lastError);
      } else {
        console.log("Proxy Grok dinonaktifkan.");
      }
    });
    return;
  }

  const pacScript = buildGrokPacScript(proxyRule);
  if (pacScript === activeProxyPac) return;

  chrome.proxy.settings.set(
    {
      value: {
        mode: "pac_script",
        pacScript: {
          data: pacScript,
        },
      },
      scope: "regular",
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("Gagal menerapkan proxy Grok:", chrome.runtime.lastError);
        return;
      }
      activeProxyPac = pacScript;
      console.log("Proxy Grok diterapkan.");
    },
  );
}

function buildProxyRule(rawUrl) {
  const config = parseProxyUrl(rawUrl);
  if (!config) return null;
  return `${config.type} ${config.host}:${config.port}`;
}

function parseProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const normalized = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(normalized);
    if (!url.hostname) return null;
    const protocol = url.protocol.replace(":", "").toLowerCase();
    const type = resolveProxyType(protocol);
    if (!type) return null;
    const port = Number(url.port || defaultPortForScheme(protocol));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      type,
      host: url.hostname,
      port,
    };
  } catch (error) {
    console.warn("Proxy URL tidak valid:", error);
    return null;
  }
}

function resolveProxyType(protocol) {
  switch (protocol) {
    case "http":
      return "PROXY";
    case "https":
      return "HTTPS";
    case "socks":
    case "socks4":
      return "SOCKS";
    case "socks5":
      return "SOCKS5";
    default:
      return null;
  }
}

function defaultPortForScheme(protocol) {
  switch (protocol) {
    case "https":
      return 443;
    case "socks":
    case "socks4":
      return 1080;
    case "socks5":
      return 1080;
    default:
      return 80;
  }
}

function buildGrokPacScript(proxyRule) {
  return `
function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, "grok.com") || shExpMatch(host, "*.grok.com")) {
    return "${proxyRule}";
  }
  return "DIRECT";
}
`.trim();
}
