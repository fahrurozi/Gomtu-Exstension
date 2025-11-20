(() => {
  const GROK_MESSAGE_TYPE = "GROK_GENERATE_TWEET";
  const GROK_OPEN_WITH_PROMPT = "GROK_OPEN_WITH_PROMPT";

  function normalizeAccountUrl(raw) {
    if (typeof raw !== "string") return "";
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const handle = trimmed.replace(/^@/, "");
    if (!handle) return "";
    return `https://x.com/${handle}`;
  }

  function buildGrokPromptFromProject(project) {
    if (!project || typeof project !== "object") return "";
    const name = typeof project.name === "string" ? project.name.trim() : "";
    if (!name) return "";
    const account = typeof project.account === "string" ? project.account.trim() : "";
    const accountUrl = normalizeAccountUrl(account);
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

  function requestGrokTweet(project, outputEl, triggerBtn, onResult) {
    if (!outputEl) return;
    const setOutput = (text) => {
      outputEl.textContent = text;
    };

    if (!chrome?.runtime?.sendMessage) {
      setOutput("Runtime messaging tidak tersedia.");
      if (typeof onResult === "function") onResult("");
      return;
    }

    if (!project || typeof project !== "object") {
      setOutput("Data project tidak valid.");
      if (typeof onResult === "function") onResult("");
      return;
    }

    if (triggerBtn) {
      triggerBtn.disabled = true;
    }
    setOutput("Meminta Grok...");

    chrome.runtime.sendMessage({ type: GROK_MESSAGE_TYPE, project }, (response) => {
      if (triggerBtn) {
        triggerBtn.disabled = false;
      }
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || "Gagal mengirim pesan.";
        const hint = message.includes("The message port closed")
          ? "Service worker mati. Reload ekstensi di chrome://extensions lalu coba lagi."
          : message;
        setOutput(`Error: ${hint}`);
        if (typeof onResult === "function") onResult("");
        return;
      }
      if (!response?.ok) {
        setOutput(`Error: ${response?.error || "Tidak ada respons"}`);
        if (typeof onResult === "function") onResult("");
        return;
      }
      const text = typeof response?.data?.text === "string" ? response.data.text.trim() : "";
      setOutput(text || "Grok tidak mengirim teks.");
      if (typeof onResult === "function") onResult(text);
    });
  }

  async function copyGrokPrompt(project, outputEl, triggerBtn) {
    const prompt = buildGrokPromptFromProject(project);
    if (!prompt) {
      if (outputEl) outputEl.textContent = "Prompt tidak valid.";
      return;
    }
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = prompt;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      if (outputEl) outputEl.textContent = "Prompt sudah disalin. Tempel manual di Grok.";
    } catch (error) {
      console.error("Failed to copy prompt:", error);
      if (outputEl) outputEl.textContent = "Gagal menyalin prompt, coba copy manual.";
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  function openGrokWithPrompt(project, outputEl, triggerBtn) {
    const prompt = buildGrokPromptFromProject(project);
    if (!prompt) {
      if (outputEl) outputEl.textContent = "Prompt tidak valid.";
      return;
    }
    if (!chrome?.runtime?.sendMessage) {
      if (outputEl) outputEl.textContent = "Runtime messaging tidak tersedia.";
      return;
    }
    if (triggerBtn) triggerBtn.disabled = true;
    outputEl.textContent = "Membuka Grok...";
    chrome.runtime.sendMessage({ type: GROK_OPEN_WITH_PROMPT, project }, (response) => {
      if (triggerBtn) triggerBtn.disabled = false;
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "Gagal mengirim pesan.";
        const lowered = msg.toLowerCase();
        if (lowered.includes("message port closed")) {
          outputEl.textContent = "Service worker mati. Reload ekstensi lalu klik lagi. Prompt tetap bisa dicopy.";
        } else {
          outputEl.textContent = `Error: ${msg}`;
        }
        return;
      }
      if (!response?.ok) {
        outputEl.textContent = `Error: ${response?.error || "Gagal membuka Grok."}`;
        return;
      }
      outputEl.textContent = "Tab Grok terbuka & prompt sudah diisi. Cek tab tersebut.";
    });
  }

  function openExternalUrl(url) {
    if (!url) return;
    if (chrome?.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function openTweetIntent(text) {
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) return;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(body)}`;
    openExternalUrl(url);
  }

  window.Grok = {
    GROK_MESSAGE_TYPE,
    GROK_OPEN_WITH_PROMPT,
    buildGrokPromptFromProject,
    requestGrokTweet,
    copyGrokPrompt,
    openGrokWithPrompt,
    openTweetIntent,
  };
})();
