(function () {
  if (!/^https?:\/\/(?:www\.)?grok\.com/i.test(location.href)) return;

  const MAX_TWEET_LENGTH = 280;

  const styles = `
    .gomtu-post-wrapper {
      display: flex;
      justify-content: flex-start;
      margin-top: 8px;
    }
    .gomtu-post-btn {
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: linear-gradient(135deg, #60a5fa, #38bdf8);
      color: #0f172a;
      font-weight: 700;
      font-size: 13px;
      padding: 9px 14px;
      border-radius: 12px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
      cursor: pointer;
      display: inline-flex;
      gap: 8px;
      align-items: center;
      transition: transform 120ms ease, box-shadow 120ms ease;
    }
    .gomtu-post-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(0,0,0,0.24); }
    .gomtu-post-btn:active { transform: translateY(0); }
    .gomtu-post-btn__icon {
      width: 18px;
      height: 18px;
      display: inline-block;
    }
  `;

  function injectStyles() {
    const el = document.createElement("style");
    el.textContent = styles;
    document.head.appendChild(el);
  }

  function createButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gomtu-post-btn";
    btn.title = "Gunakan hasil Grok untuk post ke X (gunakan teks terpilih atau pesan terakhir).";
    btn.innerHTML = `
      <span class="gomtu-post-btn__icon" aria-hidden="true">✕</span>
      <span>Post ke X</span>
    `;
    btn.addEventListener("click", () => handlePost(btn));
    return btn;
  }

  function getSelectedText() {
    const sel = window.getSelection ? window.getSelection() : null;
    const text = sel ? sel.toString().trim() : "";
    return text || "";
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function getLatestResponseText() {
    const containers = Array.from(document.querySelectorAll('[id^="response-"]'));
    if (!containers.length) return "";
    const last = containers[containers.length - 1];
    const text = normalizeText(last?.innerText || last?.textContent);
    return text && text.length > 10 ? text : "";
  }

  function truncateTweet(text) {
    if (!text) return "";
    if (text.length <= MAX_TWEET_LENGTH) return text;
    return `${text.slice(0, MAX_TWEET_LENGTH - 1).trimEnd()}…`;
  }

  function handlePost(btn) {
    const selected = getSelectedText();
    const latest = selected || getLatestResponseText();
    if (!latest) {
      flash(btn, "Tidak ada teks", 1400);
      return;
    }
    const tweet = truncateTweet(latest);
    const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
    flash(btn, "Buka X…", 1200);
  }

  function flash(btn, text, delay = 1200) {
    if (!btn) return;
    const label = btn.querySelector("span:last-child");
    const prev = label?.textContent;
    if (label) label.textContent = text;
    setTimeout(() => {
      if (label) label.textContent = prev || "Post ke X";
    }, delay);
  }

  function placeButton() {
    const containers = Array.from(document.querySelectorAll('[id^="response-"]'));
    const target = containers[containers.length - 1];
    if (!target) return placeFallback();

    if (target.querySelector(".gomtu-post-wrapper")) return true;

    const wrapper = document.createElement("div");
    wrapper.className = "gomtu-post-wrapper";
    const btn = createButton();
    wrapper.appendChild(btn);

    const actions = target.querySelector(".action-buttons");
    if (actions && actions.parentElement) {
      actions.parentElement.insertBefore(wrapper, actions.nextSibling);
      return true;
    }

    const content = target.querySelector(".response-content-markdown") || target.lastElementChild;
    if (content?.parentElement) {
      content.parentElement.insertBefore(wrapper, content.nextSibling);
      return true;
    }

    target.appendChild(wrapper);
    return true;
  }

  function placeFallback() {
    if (document.querySelector(".gomtu-post-fixed")) return true;
    const btn = createButton();
    btn.classList.add("gomtu-post-fixed");
    btn.style.position = "fixed";
    btn.style.bottom = "16px";
    btn.style.right = "16px";
    btn.style.zIndex = "2147483647";
    document.body.appendChild(btn);
    return true;
  }

  function init() {
    injectStyles();
    placeButton();
    const obs = new MutationObserver(() => placeButton());
    obs.observe(document.body, { childList: true, subtree: true });
    const interval = setInterval(() => {
      const placed = placeButton();
      if (placed) clearInterval(interval);
    }, 2000);
    setTimeout(() => clearInterval(interval), 12000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
