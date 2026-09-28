"use strict";
/* Мини-приложение «Почта»: список писем, чтение, фото и файлы.
   Все данные приходят с сервера на ноутбуке; каждый запрос подписан Telegram (initData). */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const initData = tg ? tg.initData : "";
  const $ = (id) => document.getElementById(id);

  const state = {
    folder: "INBOX",
    folders: [["INBOX", "Входящие"], ["Sent Items", "Отправленные"]],
    items: [],
    total: 0,
    unseen: 0,
    loading: false,
    listError: false,
    index: -1,          // какое письмо открыто
    letterToken: 0,     // защита от «гонки», когда быстро листаешь письма
    viewer: { images: [], index: 0 },
  };

  // ---------- мелкие помощники ----------

  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  function icon(name, cls) {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.innerHTML = ICONS[name]; // только наши постоянные значки, данных писем тут нет
    return span;
  }

  // Создание элементов без innerHTML — текст писем никогда не превращается в разметку
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : String(child));
    }
    return node;
  }

  function haptic() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) { /* не страшно */ }
  }

  function supports(version) {
    return !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(version));
  }

  const isWide = () => window.matchMedia("(min-width: 820px)").matches;

  // ---------- даты, размеры, аватарки ----------

  const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
    "сентября", "октября", "ноября", "декабря"];
  const pad = (n) => String(n).padStart(2, "0");
  const time = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());

  function shortDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return time(d);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "вчера";
    if (d.getFullYear() === now.getFullYear()) return d.getDate() + " " + MONTHS[d.getMonth()];
    return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + String(d.getFullYear()).slice(2);
  }

  function fullDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    let text = d.getDate() + " " + MONTHS_FULL[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) text += " " + d.getFullYear();
    return text + ", " + time(d);
  }

  function formatSize(size) {
    if (size < 1024) return size + " Б";
    if (size < 1024 * 1024) return Math.round(size / 1024) + " КБ";
    return (size / 1024 / 1024).toFixed(1).replace(".", ",") + " МБ";
  }

  const AVATAR_COLORS = ["#e17076", "#eda86c", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae", "#e0a03d"];

  function personName(person) {
    return (person && (person.name || person.address)) || "Без имени";
  }

  function avatar(person, large) {
    const name = personName(person).replace(/["'«»()]/g, "").trim();
    const words = name.split(/[\s.@_-]+/).filter(Boolean);
    let initials = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 1);
    let hash = 0;
    for (const ch of (person && person.address) || name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const node = el("div", { class: "avatar" + (large ? " large" : ""), "aria-hidden": "true", text: initials.toUpperCase() });
    node.style.background = AVATAR_COLORS[hash % AVATAR_COLORS.length];
    return node;
  }

  // ---------- где сервер (ноутбук) ----------
  // Открыто кнопкой «Почта» в чате — страница пришла с самого ноутбука, сервер тот же.
  // Открыто из BotFather — страница лежит на GitHub Pages (тогда у <html> есть data-repo),
  // а текущий адрес ноутбука программа записывает в tunnel.json этого репозитория.

  const REPO = document.documentElement.dataset.repo || "";
  const BRANCH = document.documentElement.dataset.branch || "main";
  const SERVER_RE = /^https:\/\/[a-z0-9-]+\.(lhr\.life|trycloudflare\.com)$/; // только наши туннели
  const OFFLINE = "Ноутбук сейчас не на связи. Приложение работает, пока он включён и не спит.";
  let server = "";
  let serverSearch = null;

  async function readTunnelAddress() {
    // Сначала через API GitHub (без задержки кэша), если не вышло — через raw (кэш до 5 минут)
    try {
      const r = await fetch("https://api.github.com/repos/" + REPO + "/contents/tunnel.json?ref=" + BRANCH,
        { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
      if (r.ok) return (await r.json()).url;
    } catch (e) { /* пробуем второй способ */ }
    const r = await fetch("https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/tunnel.json?t=" + Date.now(),
      { cache: "no-store" });
    return (await r.json()).url;
  }

  async function findServer() {
    let url;
    try {
      url = await readTunnelAddress();
    } catch (e) {
      throw new Error("Не удалось узнать адрес ноутбука. Проверьте интернет.");
    }
    if (!url || !SERVER_RE.test(url)) throw new Error(OFFLINE);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url + "/health", { cache: "no-store", signal: controller.signal });
      if (!r.ok || (await r.text()) !== "ok") throw new Error();
    } catch (e) {
      throw new Error(OFFLINE);
    } finally {
      clearTimeout(timer);
    }
    server = url;
  }

  function ensureServer() {
    if (!REPO || server) return Promise.resolve();
    if (!serverSearch) serverSearch = findServer().finally(() => { serverSearch = null; });
    return serverSearch;
  }

  // ---------- запросы к серверу ----------

  async function api(path, params, retried) {
    await ensureServer();
    let response;
    try {
      response = await fetch(server + path + "?" + new URLSearchParams(params), {
        headers: { "X-Telegram-Init-Data": initData },
        cache: "no-store",
      });
    } catch (e) {
      if (REPO && !retried) {           // адрес ноутбука мог смениться — узнаём заново
        server = "";
        return api(path, params, true);
      }
      throw new Error("Нет связи с ноутбуком. Он включён и не спит?");
    }
    let data = null;
    try { data = await response.json(); } catch (e) { /* ответ не JSON */ }
    if (!response.ok || !data) {
      throw new Error((data && data.error) || "Ноутбук не отвечает (код " + response.status + "). Он включён и не спит?");
    }
    return data;
  }

  // ---------- папки и список ----------

  function renderFolders() {
    const box = $("folders");
    box.textContent = "";
    for (const [id, title] of state.folders) {
      const selected = id === state.folder;
      const button = el("button", {
        type: "button", role: "tab", "aria-selected": selected ? "true" : "false",
        onclick: () => switchFolder(id),
      }, title);
      if (id === "INBOX" && state.unseen > 0 && selected) button.append(el("span", { class: "count", text: state.unseen }));
      box.append(button);
    }
  }

  function switchFolder(id) {
    if (id === state.folder) return;
    haptic();
    state.folder = id;
    state.items = [];
    state.total = 0;
    state.unseen = 0;
    state.index = -1;
    renderFolders();
    closeLetter();
    showPlaceholder();
    $("list-view").scrollTop = 0;
    loadList(true);
  }

  function listItem(item, index) {
    const sent = state.folder !== "INBOX";
    const person = sent ? item.to : item.from;
    const node = el("div", {
      class: "item" + (item.seen || sent ? "" : " unread") + (index === state.index ? " active" : ""),
      role: "listitem", tabindex: "0",
      onclick: () => openLetter(index),
      onkeydown: (event) => { if (event.key === "Enter") openLetter(index); },
    },
      avatar(person),
      el("div", { class: "main" },
        el("div", { class: "row" },
          el("span", { class: "name", text: (sent ? "Кому: " : "") + personName(person) }),
          item.attach ? icon("clip", "clip") : null,
          el("span", { class: "date", text: shortDate(item.date) })),
        el("div", { class: "row" },
          el("span", { class: "subject", text: item.subject || "(без темы)" }),
          item.seen || sent ? null : el("span", { class: "dot", "aria-label": "не прочитано" }))));
    node.dataset.index = index;
    return node;
  }

  function renderList() {
    const list = $("list");
    list.textContent = "";
    state.items.forEach((item, index) => list.append(listItem(item, index)));
  }

  function renderSkeleton() {
    const list = $("list");
    list.textContent = "";
    for (let i = 0; i < 8; i++) {
      list.append(el("div", { class: "skeleton-row" },
        el("div", { class: "sk circle" }),
        el("div", { style: "flex:1" },
          el("div", { class: "sk line", style: "width:" + (40 + (i * 17) % 35) + "%" }),
          el("div", { class: "sk line", style: "width:" + (60 + (i * 23) % 35) + "%" }))));
    }
  }

  function setStatus(text, retry) {
    const box = $("list-status");
    box.textContent = "";
    if (!text) return;
    box.append(el("div", { text }));
    if (retry) box.append(el("button", { type: "button", onclick: retry }, "Повторить"));
  }

  async function loadList(reset) {
    if (state.loading) return;
    state.loading = true;
    state.listError = false;
    const refresh = $("refresh");
    refresh.classList.add("spinning");
    if (reset && state.items.length === 0) renderSkeleton();
    setStatus(reset ? "" : "Загрузка…");
    const folder = state.folder;
    try {
      const data = await api("/api/list", { folder, offset: reset ? 0 : state.items.length });
      if (folder !== state.folder) return;          // пока грузили, переключили папку
      if (data.folders) state.folders = data.folders;
      state.total = data.total;
      state.unseen = data.unseen;
      if (reset) {
        const openedUid = state.index >= 0 && state.items[state.index] ? state.items[state.index].uid : null;
        state.items = data.items;
        state.index = openedUid === null ? -1 : state.items.findIndex((item) => item.uid === openedUid);
      } else {
        const known = new Set(state.items.map((item) => item.uid));
        state.items = state.items.concat(data.items.filter((item) => !known.has(item.uid)));
      }
      renderFolders();
      renderList();
      updateNav();
      setStatus(state.items.length === 0 ? "В этой папке пока нет писем" : "");
    } catch (error) {
      state.listError = true;
      if (reset && state.items.length === 0) $("list").textContent = "";
      setStatus(error.message, () => loadList(reset));
    } finally {
      state.loading = false;
      refresh.classList.remove("spinning");
    }
  }

  const hasMore = () => state.items.length < state.total;

  // ---------- письмо ----------

  function showPlaceholder() {
    const box = $("letter");
    box.textContent = "";
    box.append(el("div", { class: "placeholder", text: state.items.length ? "Выберите письмо" : "" }));
    $("position").textContent = "";
  }

  function updateNav() {
    const open = state.index >= 0;
    $("prev").disabled = !open || state.index === 0;
    $("next").disabled = !open || (state.index >= state.items.length - 1 && !hasMore());
    $("position").textContent = open ? (state.index + 1) + " из " + state.total : "";
    document.querySelectorAll(".item.active").forEach((node) => node.classList.remove("active"));
    const active = document.querySelector('.item[data-index="' + state.index + '"]');
    if (active) {
      active.classList.add("active");
      if (isWide()) active.scrollIntoView({ block: "nearest" });
    }
  }

  async function openLetter(index) {
    if (index < 0) return;
    if (index >= state.items.length && hasMore()) await loadList(false);
    if (index >= state.items.length) return;
    haptic();
    state.index = index;
    updateNav();
    document.body.classList.add("letter-open");
    updateBackButton();

    const item = state.items[index];
    const token = ++state.letterToken;
    renderLetterSkeleton(item);
    $("letter-view").scrollTop = 0;
    try {
      const letter = await api("/api/letter", { folder: state.folder, uid: item.uid });
      if (token !== state.letterToken) return;
      renderLetter(letter);
    } catch (error) {
      if (token !== state.letterToken) return;
      const box = $("letter");
      box.lastChild && box.lastChild.remove();
      box.append(el("div", { class: "card error-card" },
        el("div", { text: error.message }),
        el("button", { type: "button", onclick: () => openLetter(index) }, "Повторить")));
    }
  }

  function closeLetter() {
    document.body.classList.remove("letter-open");
    state.letterToken++;
    updateBackButton();
  }

  function senderCard(from, date, extra) {
    return el("div", { class: "card" },
      el("div", { class: "sender" },
        avatar(from, true),
        el("div", { class: "who" },
          el("div", { class: "name", text: personName(from) }),
          from.name && from.address ? el("div", { class: "addr", text: from.address }) : null,
          el("div", { class: "when", text: fullDate(date) }))),
      extra);
  }

  function renderLetterSkeleton(item) {
    const box = $("letter");
    box.textContent = "";
    box.append(el("h1", { class: "subject-title", text: item.subject || "(без темы)" }));
    box.append(senderCard(item.from, item.date, null));
    box.append(el("div", { class: "card" },
      el("div", { class: "sk line", style: "width:90%" }),
      el("div", { class: "sk line", style: "width:75%" }),
      el("div", { class: "sk line", style: "width:82%" }),
      el("div", { class: "sk line", style: "width:40%" })));
  }

  function recipients(label, people) {
    if (!people || people.length === 0) return null;
    const LIMIT = 3;
    const line = el("div", {}, label + ": ");
    const names = people.map((person) => person.name ? person.name + " <" + person.address + ">" : person.address);
    line.append(el("b", { text: names.slice(0, LIMIT).join(", ") }));
    if (names.length > LIMIT) {
      const more = el("button", { class: "more", type: "button" }, " и ещё " + (names.length - LIMIT));
      more.addEventListener("click", () => {
        more.remove();
        line.querySelector("b").textContent = names.join(", ");
      });
      line.append(more);
    }
    return line;
  }

  function renderLetter(letter) {
    const box = $("letter");
    box.textContent = "";
    box.append(el("h1", { class: "subject-title", text: letter.subject }));

    const people = el("div", { class: "recipients" }, recipients("Кому", letter.to), recipients("Копия", letter.cc));
    box.append(senderCard(letter.from, letter.date, people.childNodes.length ? people : null));

    box.append(bodyFrame(letter));

    const images = letter.files.filter((file) => file.image);
    const others = letter.files.filter((file) => !file.image);
    if (images.length) box.append(gallery(images));
    if (others.length) {
      box.append(el("div", { class: "card" },
        el("div", { class: "section-title", text: others.length === 1 ? "Файл" : "Файлы · " + others.length }),
        others.map(fileRow)));
    }
  }

  function gallery(images) {
    const grid = el("div", { class: "gallery" + (images.length === 1 ? " single" : "") });
    images.forEach((image, index) => {
      const img = el("img", { src: image.view, alt: image.name, loading: "lazy", decoding: "async" });
      grid.append(el("button", { class: "tile", type: "button", "aria-label": "Открыть " + image.name,
        onclick: () => openViewer(images, index) }, img));
    });
    return el("div", { class: "card" },
      el("div", { class: "section-title", text: images.length === 1 ? "Фото" : "Фото · " + images.length }),
      grid);
  }

  const EXT_COLORS = {
    pdf: "#e5534b", doc: "#3b7ddd", docx: "#3b7ddd", rtf: "#3b7ddd", odt: "#3b7ddd",
    xls: "#22a06b", xlsx: "#22a06b", csv: "#22a06b", ods: "#22a06b",
    ppt: "#e8743b", pptx: "#e8743b", odp: "#e8743b",
    zip: "#8d8d94", rar: "#8d8d94", "7z": "#8d8d94",
  };

  function fileRow(file) {
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
    const badge = el("div", { class: "ext", text: (ext || "файл").slice(0, 4) });
    badge.style.background = EXT_COLORS[ext] || "var(--accent)";
    return el("div", { class: "file", role: "button", tabindex: "0", title: "Скачать",
      onclick: () => download(file) },
      badge,
      el("div", { class: "meta" },
        el("div", { class: "fname", text: file.name }),
        el("div", { class: "fsize", text: formatSize(file.size) })),
      icon("download", "dl"));
  }

  function download(file) {
    haptic();
    const url = new URL(file.download, location.href).href;
    if (supports("8.0") && tg.downloadFile) {
      tg.downloadFile({ url, file_name: file.name });
    } else if (tg && tg.openLink) {
      tg.openLink(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  // ---------- текст письма в «песочнице» (без скриптов) ----------

  // HTML-письмо (рассылки с вёрсткой) всегда рисуется на белом фоне, как на сайте почты
  function frameDocument(letter) {
    const style = ":root{color-scheme:light}html,body{margin:0}" +
      "body{padding:14px 16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "word-wrap:break-word;overflow-wrap:anywhere;color:#1f1f1f;background:#fff}" +
      "img{max-width:100%;height:auto}a{color:#1a73e8}" +
      "blockquote{margin:0 0 0 4px;padding-left:10px;border-left:3px solid rgba(127,127,127,.4)}";
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><base target="_blank">' +
      '<meta name="referrer" content="no-referrer"><style>' + style + "</style></head><body>" +
      letter.body + "</body></html>";
  }

  // Обычное текстовое письмо: показываем прямо на странице цветами темы Telegram.
  // Текст вставляется только как текст (textContent), ссылки — отдельными элементами.
  const LINK_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

  function plainBody(text) {
    const box = el("div", { class: "plain-body" });
    let last = 0;
    for (const match of text.matchAll(LINK_RE)) {
      box.append(text.slice(last, match.index));
      const url = match[0];
      box.append(el("a", { href: url, target: "_blank", rel: "noopener noreferrer", onclick: (event) => {
        if (tg && tg.openLink) {
          event.preventDefault();
          tg.openLink(url);
        }
      } }, url));
      last = match.index + url.length;
    }
    box.append(text.slice(last));
    return box;
  }

  function bodyFrame(letter) {
    const card = el("div", { class: "card body-card " + (letter.kind === "html" ? "html" : "plain") });
    const empty = letter.kind === "html"
      ? !letter.body.replace(/<[^>]*>/g, "").trim() && letter.body.indexOf("<img") < 0
      : !letter.body.trim();
    if (!letter.body || empty) {
      card.append(el("div", { class: "empty-body", text: "(письмо без текста)" }));
      return card;
    }
    if (letter.kind !== "html") {
      card.append(plainBody(letter.body));
      return card;
    }
    // sandbox без allow-scripts: скрипты из письма не выполняются никогда
    const frame = el("iframe", {
      sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      referrerpolicy: "no-referrer",
      title: "Текст письма",
    });
    frame.srcdoc = frameDocument(letter);
    frame.addEventListener("load", () => setupFrame(frame, true));
    card.append(frame);
    return card;
  }

  function setupFrame(frame, isHtml) {
    let doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;

    // Ссылки из письма открываем во внешнем браузере Telegram
    doc.addEventListener("click", (event) => {
      const link = event.target.closest ? event.target.closest("a[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      if (/^https?:/i.test(link.href) && tg && tg.openLink) {
        event.preventDefault();
        tg.openLink(link.href);
      }
    });

    // Широкие письма (рассылки шириной 600px+) уменьшаем, чтобы влезли в экран телефона
    const fit = () => {
      if (!frame.isConnected || !doc.body) return;
      if (isHtml) {
        doc.body.style.zoom = "";
        const available = frame.clientWidth;
        const needed = doc.documentElement.scrollWidth;
        if (needed > available + 2) doc.body.style.zoom = String(Math.max(0.35, available / needed));
      }
      frame.style.height = Math.ceil(doc.documentElement.scrollHeight) + 2 + "px";
    };
    fit();
    doc.querySelectorAll("img").forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", fit);
        img.addEventListener("error", fit);
      }
    });
    // Картинки из интернета могут догружаться — перемеряем несколько раз
    [300, 1200, 3000, 7000].forEach((ms) => setTimeout(fit, ms));
    frame._fit = fit;
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll(".body-card iframe").forEach((frame) => frame._fit && frame._fit());
      updateBackButton();
    }, 200);
  });

  // ---------- просмотр фото ----------

  function openViewer(images, index) {
    haptic();
    state.viewer = { images, index };
    showViewerImage();
    $("viewer").hidden = false;
    updateBackButton();
  }

  function showViewerImage() {
    const { images, index } = state.viewer;
    const image = images[index];
    $("viewer-img").src = image.view;
    $("viewer-img").alt = image.name;
    $("viewer-name").textContent = image.name;
    $("viewer-count").textContent = images.length > 1 ? (index + 1) + " из " + images.length : formatSize(image.size);
    $("viewer-prev").hidden = index === 0;
    $("viewer-next").hidden = index === images.length - 1;
  }

  function stepViewer(delta) {
    const next = state.viewer.index + delta;
    if (next < 0 || next >= state.viewer.images.length) return;
    haptic();
    state.viewer.index = next;
    showViewerImage();
  }

  function closeViewer() {
    $("viewer").hidden = true;
    $("viewer-img").removeAttribute("src");
    updateBackButton();
  }

  let touchX = null;
  $("viewer").addEventListener("touchstart", (event) => { touchX = event.touches[0].clientX; }, { passive: true });
  $("viewer").addEventListener("touchend", (event) => {
    if (touchX === null) return;
    const dx = event.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  });

  // ---------- кнопка «Назад» ----------

  const viewerOpen = () => !$("viewer").hidden;
  const letterOpen = () => document.body.classList.contains("letter-open") && !isWide();

  function goBack() {
    if (viewerOpen()) closeViewer();
    else if (letterOpen()) closeLetter();
  }

  function updateBackButton() {
    if (!supports("6.1")) return;
    if (viewerOpen() || letterOpen()) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  // ---------- запуск ----------

  function init() {
    $("refresh").append(icon("refresh"));
    $("back").append(icon("back"));
    $("prev").append(icon("up"));
    $("next").append(icon("down"));
    $("viewer-close").append(icon("close"));
    $("viewer-download").append(icon("download"));
    $("viewer-prev").append(icon("left"));
    $("viewer-next").append(icon("right"));

    $("refresh").addEventListener("click", () => { haptic(); loadList(true); });
    $("back").addEventListener("click", closeLetter);
    $("prev").addEventListener("click", () => openLetter(state.index - 1));
    $("next").addEventListener("click", () => openLetter(state.index + 1));
    $("viewer-close").addEventListener("click", closeViewer);
    $("viewer-prev").addEventListener("click", () => stepViewer(-1));
    $("viewer-next").addEventListener("click", () => stepViewer(1));
    $("viewer-download").addEventListener("click", () => download(state.viewer.images[state.viewer.index]));

    for (const id of ["list-view", "letter-view"]) {
      const view = $(id);
      view.addEventListener("scroll", () => view.classList.toggle("scrolled", view.scrollTop > 4), { passive: true });
    }

    document.addEventListener("keydown", (event) => {
      if (viewerOpen()) {
        if (event.key === "ArrowLeft") stepViewer(-1);
        if (event.key === "ArrowRight") stepViewer(1);
        if (event.key === "Escape") closeViewer();
        return;
      }
      if (state.index < 0) return;
      if (event.key === "ArrowDown" || event.key === "j") openLetter(state.index + 1);
      if (event.key === "ArrowUp" || event.key === "k") openLetter(state.index - 1);
      if (event.key === "Escape") closeLetter();
    });

    if (tg) {
      tg.ready();
      tg.expand();
      try {
        if (supports("6.1")) {
          tg.setHeaderColor("secondary_bg_color");
          tg.setBackgroundColor("secondary_bg_color");
          tg.BackButton.onClick(goBack);
          $("back").hidden = true;          // в Telegram есть своя кнопка «Назад»
        }
        if (supports("7.7")) tg.disableVerticalSwipes(); // чтобы прокрутка письма не закрывала приложение
      } catch (e) { /* старая версия Telegram */ }
    }

    renderFolders();
    if (!initData) {
      setStatus("Откройте приложение через кнопку «Почта» в чате с ботом в Telegram.");
      return;
    }

    // Подгружаем следующие письма, когда список докрутили до конца
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore() && !state.loading && !state.listError) loadList(false);
      }, { root: $("list-view"), rootMargin: "400px" }).observe($("sentinel"));
    }
    loadList(true).then(openFromLink);
  }

  // Открыли по ссылке «Полностью — в приложении» из чата: сразу показываем это письмо
  async function openFromLink() {
    const param = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param || "" : "";
    const match = /^l(\d+)$/.exec(param);
    if (!match || state.folder !== "INBOX") return;
    const uid = Number(match[1]);
    for (let page = 0; page < 5; page++) {
      const index = state.items.findIndex((item) => item.uid === uid);
      if (index >= 0) return openLetter(index);
      if (!hasMore() || state.listError) return;
      await loadList(false);
    }
  }

  init();
})();
