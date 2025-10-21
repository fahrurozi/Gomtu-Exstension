function formatValue(raw) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return "–";
  const abs = Math.abs(num);
  if (abs >= 1000) return Math.round(num).toLocaleString();
  if (abs >= 100) return num.toFixed(0);
  return num.toFixed(1);
}

function formatTooltipValue(num) {
  const value = typeof num === "number" ? num : Number(num);
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString();
  if (abs >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  }
  if (abs === 0) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 4, minimumFractionDigits: 2 });
}

const MAX_LEADERBOARD_VISIBLE = 3;
const LEADERBOARD_DURATION_PRIORITY = ["7D", "30D", "3M", "6M", "12M", "90D", "ALL"];
const LEADERBOARD_PRIORITY_MAP = LEADERBOARD_DURATION_PRIORITY.reduce((map, key, idx) => {
  map[key] = idx;
  return map;
}, {});

function createBadge(label, value, variant = "primary") {
  const badge = document.createElement("span");
  badge.className = `gomtu-badge gomtu-badge--${variant}`;

  const labelEl = document.createElement("span");
  labelEl.className = "gomtu-badge-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "gomtu-badge-value";
  valueEl.textContent = formatValue(value);

  badge.title = `${label}: ${formatTooltipValue(value)}`;
  badge.append(labelEl, valueEl);
  return badge;
}

function placeAfter(parent, node, reference) {
  if (!parent || !node) return;
  if (!reference || reference.parentElement !== parent) {
    parent.appendChild(node);
    return;
  }
  const next = reference.nextSibling;
  if (next === node) return;
  parent.insertBefore(node, next);
}

function ensureBadgeRow(parent, className) {
  const selector = className
    .split(" ")
    .filter(Boolean)
    .map((cls) => `.${cls}`)
    .join("");
  let row = parent.querySelector(selector);
  if (!row) {
    row = document.createElement("div");
    row.className = className;
  }
  return row;
}

function createFallbackAvatar(name = "") {
  const el = document.createElement("div");
  el.className = "gomtu-leaderboard-card-avatar";
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  el.textContent = initial;
  return el;
}

function createLeaderboardCard(entry) {
  const topic = entry.topic || {};
  const card = document.createElement("div");
  card.className = "gomtu-leaderboard-card";

  let avatar;
  if (topic.imgUrl) {
    avatar = document.createElement("img");
    avatar.className = "gomtu-leaderboard-card-avatar";
    avatar.src = topic.imgUrl;
    avatar.alt = topic.name || topic.ticker || "Project";
  } else {
    avatar = createFallbackAvatar(topic.name || topic.ticker || "");
  }

  const textWrap = document.createElement("div");
  textWrap.className = "gomtu-leaderboard-card-text";

  const nameEl = document.createElement("div");
  nameEl.className = "gomtu-leaderboard-card-name";
  nameEl.textContent = topic.name || topic.ticker || `ID ${entry.topic_id}`;

  const duration = (entry.duration || "").toString().toUpperCase();
  const rankText = Number.isFinite(entry.rank) ? `#${entry.rank}` : "#?";
  const detailEl = document.createElement("div");
  detailEl.className = "gomtu-leaderboard-card-detail";
  detailEl.textContent = duration ? `${duration} · ${rankText}` : rankText;

  textWrap.append(nameEl, detailEl);
  card.append(avatar, textWrap);

  const tooltipBits = [];
  if (topic.ticker) tooltipBits.push(`Ticker: ${topic.ticker}`);
  if (entry.mindshare != null) tooltipBits.push(`Mindshare: ${formatTooltipValue(entry.mindshare)}`);
  if (entry.tier) tooltipBits.push(`Tier: ${entry.tier}`);
  card.title = tooltipBits.join("\n");

  return card;
}

function applyLeaderboardVisibility(container, expanded, limit) {
  const cards = container.querySelectorAll(".gomtu-leaderboard-card");
  cards.forEach((card, idx) => {
    const hide = idx >= limit && !expanded;
    card.classList.toggle("gomtu-leaderboard-card--hidden", hide);
  });
}

function getDurationPriority(durationRaw) {
  const duration = (durationRaw || "").toString().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(LEADERBOARD_PRIORITY_MAP, duration)) {
    return LEADERBOARD_PRIORITY_MAP[duration];
  }
  return LEADERBOARD_DURATION_PRIORITY.length;
}

async function getScore(username) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SCORE", username }, (resp) => {
      if (resp?.ok) resolve(resp.data);
      else resolve(null);
    });
  });
}

async function insertBadge(el, username) {
  if (!el) return;
  const nameBlock = el.querySelector('[data-testid="User-Name"]');
  if (!nameBlock) return;
  const parent = nameBlock.parentElement;
  if (!parent) return;

  const data = await getScore(username);
  if (!data) return;

  let lastRow = nameBlock;

  const statusData = data.status;
  const existingStatusRow = parent.querySelector(".gomtu-badge-row--status");

  if (statusData) {
    const statusRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--status");
    placeAfter(parent, statusRow, lastRow);
    statusRow.textContent = "";

    const statusMetrics = [
      { label: "Smart Followers", value: statusData.smart_follower_count },
      { label: "Followers", value: statusData.follower_count },
    ];

    statusMetrics.forEach(({ label, value }) => {
      if (typeof value === "number") {
        statusRow.appendChild(createBadge(label, value, "secondary"));
      }
    });

    lastRow = statusRow;
  } else if (existingStatusRow) {
    existingStatusRow.remove();
  }

  const yapsData = data.yaps;
  const existingYapsRow = parent.querySelector(".gomtu-badge-row--yaps");
  let yapsRow = null;

  if (yapsData) {
    yapsRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--yaps");
    placeAfter(parent, yapsRow, lastRow);
    yapsRow.textContent = "";

    const metrics = [
      { label: "24h", value: yapsData.yaps_l24h },
      { label: "48h", value: yapsData.yaps_l48h },
      { label: "7d", value: yapsData.yaps_l7d },
      { label: "30d", value: yapsData.yaps_l30d },
    ];

    metrics.forEach(({ label, value }) => {
      if (typeof value === "number") {
        yapsRow.appendChild(createBadge(label, value, "primary"));
      }
    });

    lastRow = yapsRow;
  } else if (existingYapsRow) {
    existingYapsRow.remove();
  }

  const leaderboardEntries = Array.isArray(data.leaderboard) ? data.leaderboard : [];
  const existingLeaderboardRow = parent.querySelector(".gomtu-badge-row--leaderboard");

  if (leaderboardEntries.length) {
    const leaderboardRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--leaderboard");
    const wasExpanded = leaderboardRow.dataset.expanded === "true";
    placeAfter(parent, leaderboardRow, lastRow);
    leaderboardRow.textContent = "";

    const cardsWrapper = document.createElement("div");
    cardsWrapper.className = "gomtu-leaderboard-cards";
    leaderboardRow.appendChild(cardsWrapper);

    const bestByTopic = new Map();
    leaderboardEntries.forEach((entry) => {
      if (!entry) return;
      const topicKey = (entry.topic?.ticker || entry.topic_id || "").toString().toUpperCase();
      if (!topicKey) return;
      const priority = getDurationPriority(entry.duration);
      const current = bestByTopic.get(topicKey);
      if (
        !current ||
        priority < current.priority ||
        (priority === current.priority && (entry.updatedAt || 0) > (current.entry.updatedAt || 0))
      ) {
        bestByTopic.set(topicKey, { entry, priority });
      }
    });

    const sortedEntries = Array.from(bestByTopic.values())
      .map((item) => item.entry)
      .sort((a, b) => {
      const rankA = Number.isFinite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
      const rankB = Number.isFinite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const total = sortedEntries.length;
    const limit = MAX_LEADERBOARD_VISIBLE;

    if (total) {
      sortedEntries.forEach((entry) => {
        cardsWrapper.appendChild(createLeaderboardCard(entry));
      });

      if (total > limit) {
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "gomtu-leaderboard-toggle";

        const updateState = (expanded) => {
          leaderboardRow.dataset.expanded = expanded ? "true" : "false";
          applyLeaderboardVisibility(cardsWrapper, expanded, limit);
          const remaining = Math.max(total - limit, 0);
          toggleBtn.textContent = expanded ? "Show less" : `Show ${remaining} more`;
        };

        updateState(wasExpanded);
        toggleBtn.addEventListener("click", () => {
          const expanded = leaderboardRow.dataset.expanded === "true";
          updateState(!expanded);
        });

        leaderboardRow.appendChild(toggleBtn);
      } else {
        leaderboardRow.dataset.expanded = "true";
        applyLeaderboardVisibility(cardsWrapper, true, limit);
      }

      lastRow = leaderboardRow;
    } else {
      leaderboardRow.remove();
    }
  } else if (existingLeaderboardRow) {
    existingLeaderboardRow.remove();
  }
}

function findUsernameFromEl(el) {
  // Coba ambil href / text @username
  const a = el.querySelector('a[href^="/"]');
  if (a) {
    const href = a.getAttribute("href");
    if (href && href !== "/" && href.length > 2) {
      return href.replace("/", "").replace("@", "").split("/")[0];
    }
  }
  const txt = el.innerText || "";
  const match = txt.match(/@([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

function processTweets(root = document) {
  const tweets = root.querySelectorAll('[data-testid="User-Name"], [role="article"]');
  tweets.forEach((tweet) => {
    const username = findUsernameFromEl(tweet);
    if (username) insertBadge(tweet, username);
  });
}

// Observe halaman biar auto-update pas scroll
const observer = new MutationObserver((muts) => {
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) processTweets(node);
    }
  }
});

observer.observe(document, { childList: true, subtree: true });
processTweets();
