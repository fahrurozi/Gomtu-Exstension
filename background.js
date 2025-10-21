const CACHE_TTL = 1000 * 60 * 5; // 5 menit
const cache = new Map();

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_SCORE" && msg.username) {
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
});
