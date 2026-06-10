const STATIC_DATA = "data/events.json";
const DEFAULT_API = STATIC_DATA;
const DEFAULT_EVENT_IMAGE = "assets/muuc-default.png";
const HERO_INTERVAL_MS = 20000;
const HERO_EVENT_LIMIT = 5;
const THEME_STORAGE_KEY = "muuc-calendar-theme";
const HIDDEN_EVENT_TITLES = new Set(["Computer Nitrox Course with Instructor Minh"]);
const HIDDEN_TITLE_PATTERNS = [/^committee meeting$/i, /expiry/i, /\btemplate\b/i];
const DEFAULT_CLUB_MEETING = {
  event_name: "Club Meeting",
  start_time: "19:00",
  description: "Regular weekly meeting at the shed!",
};

const state = {
  events: [],
  shownDate: new Date(2026, 0, 1),
  query: "",
  monthFilter: "",
  listSort: "date",
  listSortDirection: "desc",
  featuredEvent: null,
  heroEvents: [],
  heroIndex: 0,
  heroTimer: null,
  activeHeroLayer: 0,
  heroImageReady: false,
  heroTransitionToken: 0,
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

function currentMonthKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function setDefaultMonthFilter() {
  const key = currentMonthKey();
  state.monthFilter = key;
}

const els = {
  heroMedia: document.querySelector("#heroMedia"),
  heroMediaNext: document.querySelector("#heroMediaNext"),
  heroEyebrow: document.querySelector("#heroEyebrow"),
  heroTitle: document.querySelector("#heroTitle"),
  heroDate: document.querySelector("#heroDate"),
  heroDescription: document.querySelector("#heroDescription"),
  heroButton: document.querySelector("#heroButton"),
  heroProgressFill: document.querySelector("#heroProgressFill"),
  heroProgressDots: document.querySelector("#heroProgressDots"),
  heroUpcoming: document.querySelector("#heroUpcoming"),
  monthLabel: document.querySelector("#monthLabel"),
  monthJumpPanel: document.querySelector("#monthJumpPanel"),
  jumpMonthSelect: document.querySelector("#jumpMonthSelect"),
  jumpYearSelect: document.querySelector("#jumpYearSelect"),
  calendarGrid: document.querySelector("#calendarGrid"),
  eventList: document.querySelector("#eventList"),
  status: document.querySelector("#status"),
  searchInput: document.querySelector("#searchInput"),
  monthSelect: document.querySelector("#monthSelect"),
  sortDateButton: document.querySelector("#sortDateButton"),
  sortNameButton: document.querySelector("#sortNameButton"),
  prevButton: document.querySelector("#prevButton"),
  nextButton: document.querySelector("#nextButton"),
  todayButton: document.querySelector("#todayButton"),
  themeToggle: document.querySelector("#themeToggle"),
  dialog: document.querySelector("#eventDialog"),
  closeDialog: document.querySelector("#closeDialog"),
  dialogImage: document.querySelector("#dialogImage"),
  dialogDate: document.querySelector("#dialogDate"),
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogTeamappLink: document.querySelector("#dialogTeamappLink"),
  dialogDescription: document.querySelector("#dialogDescription"),
  hoverCard: document.querySelector("#hoverCard"),
};

function apiUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("api") || window.CALENDAR_API_BASE || DEFAULT_API;
}

function preferredTheme() {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  const isDark = theme === "dark";
  els.themeToggle.textContent = isDark ? "☀" : "☾";
  els.themeToggle.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
  els.themeToggle.setAttribute("aria-pressed", String(isDark));
}

async function fetchCalendar() {
  const urls = [apiUrl(), STATIC_DATA];
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.json();
      return { data, url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseDate(value) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function fmtDate(date) {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function fmtTime(value) {
  if (!value) return "";
  const [hour, minute = "0"] = String(value).split(":");
  const date = new Date(2000, 0, 1, Number(hour), Number(minute));
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function eventDateLabel(event) {
  const date = fmtDate(parseDate(event.date));
  const endDateValue = event.end_date || event.start_date;
  const endDate = endDateValue && endDateValue !== event.date ? ` - ${fmtDate(parseDate(endDateValue))}` : "";
  const time = fmtTime(event.start_time);
  return `${date}${endDate}${time ? `, ${time}` : ""}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function byDate(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
    a.event_name.localeCompare(b.event_name)
  );
}

function byDateDesc(a, b) {
  return (
    b.date.localeCompare(a.date) ||
    String(b.start_time || "").localeCompare(String(a.start_time || "")) ||
    a.event_name.localeCompare(b.event_name)
  );
}

function byDateAsc(a, b) {
  return byDate(a, b);
}

function byName(a, b) {
  return (
    a.event_name.localeCompare(b.event_name) ||
    a.date.localeCompare(b.date) ||
    String(a.start_time || "").localeCompare(String(b.start_time || ""))
  );
}

function compareEventsForList(a, b) {
  if (state.listSort === "name") {
    const result = byName(a, b);
    return state.listSortDirection === "asc" ? result : -result;
  }
  return state.listSortDirection === "asc" ? byDateAsc(a, b) : byDateDesc(a, b);
}

function isClubMeeting(event) {
  return /^(weekly\s+)?club meeting\b/i.test(event.event_name);
}

function isCourseEvent(event) {
  return /\bcourses?\b/i.test(event.event_name || "");
}

function isPoolTrainingEvent(event) {
  return /\bpool\b/i.test(event.event_name || "") && /\btraining\b/i.test(event.event_name || "");
}

function isShoreEvent(event) {
  return /\bshore\b/i.test(event.event_name || "");
}

function isBoatEvent(event) {
  return /\bboat\b/i.test(event.event_name || "");
}

function isExpressionOfInterestEvent(event) {
  return /expressions?\s+of\s+interest/i.test(event.event_name || "");
}

function isCancelledEvent(event) {
  return /\bcancel(le)?d\b/i.test(event.event_name || "");
}

function eventCategory(event) {
  if (isCancelledEvent(event)) return "cancelled";
  if (isClubMeeting(event)) return "club-meeting";
  if (isPoolTrainingEvent(event)) return "pool-training";
  if (isShoreEvent(event)) return "shore";
  if (isCourseEvent(event)) return "course";
  if (isBoatEvent(event)) return "boat";
  return "default";
}

function isHiddenEvent(event) {
  const title = event.event_name || "";
  return HIDDEN_EVENT_TITLES.has(title) || HIDDEN_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function addDefaultClubMeetings(events, startYear) {
  if (!events.length) return events;
  const latestYear = Math.max(...events.map((event) => parseDate(event.date).getFullYear()), startYear);
  const existingMeetingDates = new Set(
    events
      .filter((event) => /^(weekly\s+)?club meeting\b/i.test(event.event_name))
      .map((event) => event.date),
  );
  const generated = [];
  const cursor = new Date(startYear, 0, 1);
  while (cursor.getDay() !== 4) cursor.setDate(cursor.getDate() + 1);
  const end = new Date(latestYear, 11, 31);

  while (cursor <= end) {
    const date = dateKey(cursor);
    if (!existingMeetingDates.has(date)) {
      generated.push({
        event_id: `default-club-meeting-${date}`,
        event_name: DEFAULT_CLUB_MEETING.event_name,
        title: DEFAULT_CLUB_MEETING.event_name,
        date,
        start_date: date,
        end_date: date,
        start_time: DEFAULT_CLUB_MEETING.start_time,
        end_time: "",
        description: DEFAULT_CLUB_MEETING.description,
        description_sections: [
          {
            title: "Info",
            fields: [{ label: "Time", value: fmtTime(DEFAULT_CLUB_MEETING.start_time) }],
            body: [DEFAULT_CLUB_MEETING.description],
          },
        ],
        source: "default",
        image_url: "",
        has_image_blob: false,
      });
    }
    cursor.setDate(cursor.getDate() + 7);
  }
  return [...events, ...generated].sort(byDate);
}

function filteredEvents() {
  const q = state.query.trim().toLowerCase();
  return state.events
    .filter((event) => !isClubMeeting(event))
    .filter((event) => !state.monthFilter || event.date.startsWith(state.monthFilter))
    .filter((event) => {
      if (!q) return true;
      return `${event.event_name} ${event.description}`.toLowerCase().includes(q);
    })
    .sort(compareEventsForList);
}

function renderSortButtons() {
  const dateActive = state.listSort === "date";
  const arrow = state.listSortDirection === "asc" ? "↑" : "↓";
  els.sortDateButton.textContent = `Date ${dateActive ? arrow : ""}`.trim();
  els.sortNameButton.textContent = `Name ${dateActive ? "" : arrow}`.trim();
  els.sortDateButton.classList.toggle("active", dateActive);
  els.sortNameButton.classList.toggle("active", !dateActive);
  els.sortDateButton.setAttribute("aria-pressed", String(dateActive));
  els.sortNameButton.setAttribute("aria-pressed", String(!dateActive));
}

function renderMonthOptions() {
  const months = [...new Set(state.events.map((event) => event.date.slice(0, 7)))].sort();
  els.monthSelect.innerHTML = '<option value="">All months</option>';
  for (const key of months) {
    const date = parseDate(`${key}-01`);
    const option = document.createElement("option");
    option.value = key;
    option.textContent = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" }).format(date);
    els.monthSelect.append(option);
  }
  if (months.includes(state.monthFilter)) {
    els.monthSelect.value = state.monthFilter;
  } else {
    state.monthFilter = "";
    els.monthSelect.value = "";
  }
}

function renderJumpOptions(startYear = 2026) {
  els.jumpMonthSelect.innerHTML = "";
  for (let month = 0; month < 12; month += 1) {
    const option = document.createElement("option");
    option.value = String(month);
    option.textContent = new Intl.DateTimeFormat("en-AU", { month: "short" }).format(new Date(2026, month, 1));
    els.jumpMonthSelect.append(option);
  }

  els.jumpYearSelect.innerHTML = "";
  const eventYears = state.events.map((event) => parseDate(event.date).getFullYear()).filter(Number.isFinite);
  const currentYear = new Date().getFullYear();
  const minYear = Math.min(startYear, currentYear, ...eventYears);
  const maxYear = Math.max(currentYear + 2, ...eventYears);
  for (let year = minYear; year <= maxYear; year += 1) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    els.jumpYearSelect.append(option);
  }
  syncJumpControls();
}

function syncJumpControls() {
  els.jumpMonthSelect.value = String(state.shownDate.getMonth());
  els.jumpYearSelect.value = String(state.shownDate.getFullYear());
}

function closeMonthJump() {
  els.monthJumpPanel.hidden = true;
  els.monthLabel.setAttribute("aria-expanded", "false");
}

function toggleMonthJump() {
  const isOpening = els.monthJumpPanel.hidden;
  els.monthJumpPanel.hidden = !isOpening;
  els.monthLabel.setAttribute("aria-expanded", String(isOpening));
  if (isOpening) {
    syncJumpControls();
    els.jumpMonthSelect.focus();
  }
}

function jumpToSelectedMonth() {
  state.shownDate = new Date(Number(els.jumpYearSelect.value), Number(els.jumpMonthSelect.value), 1);
  renderCalendar();
  closeMonthJump();
}

function eventImage(event) {
  return event.image_data_url || event.image_url || DEFAULT_EVENT_IMAGE;
}

function teamappUrl(event) {
  if (event.teamapp_url) return event.teamapp_url;
  if (String(event.event_id).startsWith("default-")) return "";
  return `https://muuc.teamapp.com/clubs/132307/events/${event.event_id}`;
}

function hasCustomImage(event) {
  return Boolean(event.image_data_url || event.image_url);
}

function sanitizeSensitiveText(value) {
  const withRedactedEmails = String(value || "")
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[redacted email]");
  const sanitizedText = withRedactedEmails.replace(
    /\b(?:\+?\d[\d\s()./\-.]{7,}\d)\b/g,
    "[redacted phone]",
  );
  return sanitizedText;
}

function isHiddenFieldLabel(label = "") {
  return /leader phone|secondary number/i.test(String(label || ""));
}

function isHealthAndSafetySection(title = "") {
  return /\bhealth\b.*\bsafety\b/i.test(String(title || ""));
}

function sectionText(section) {
  const title = String(section.title || "").toLowerCase();
  if (isHealthAndSafetySection(title)) return "";
  const fields = (section.fields || [])
    .filter((field) => field.value && !isHiddenFieldLabel(field.label))
    .map((field) => `${sanitizeSensitiveText(field.label)}: ${sanitizeSensitiveText(field.value)}`);
  const bodyLines = (section.body || []).map((line) => sanitizeSensitiveText(line)).filter(Boolean);
  return [...fields, ...bodyLines].join(" ");
}

function descriptionSummary(event, maxLength = 220) {
  const sections = event.description_sections || [];
  const relevantSections = [];
  for (const section of sections) {
    const chunk = sectionText(section);
    if (chunk) relevantSections.push(chunk);
  }
  const hasDescriptionSections = relevantSections.length > 0;
  const text = hasDescriptionSections ? relevantSections.join(" ") : sanitizeSensitiveText(event.description || "");
  const cleaned = sanitizeSensitiveText(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function renderStructuredDescription(container, event, options = {}) {
  const { compact = false } = options;
  container.innerHTML = "";
  const sections = event.description_sections || [];
  if (!sections.length) {
    const paragraph = document.createElement("p");
    paragraph.textContent = sanitizeSensitiveText(event.description || "");
    container.append(paragraph);
    return;
  }

  for (const section of sections) {
    if (isHealthAndSafetySection(section.title)) continue;
    const sectionEl = document.createElement("section");
    sectionEl.className = "description-section";
    const title = document.createElement("h3");
    title.textContent = sanitizeSensitiveText(section.title);
    sectionEl.append(title);

    if (section.fields?.length) {
      const dl = document.createElement("dl");
      for (const field of section.fields) {
        if (isHiddenFieldLabel(field.label)) continue;
        if (compact && !field.value) continue;
        const dt = document.createElement("dt");
        dt.textContent = sanitizeSensitiveText(field.label);
        const dd = document.createElement("dd");
        dd.textContent = sanitizeSensitiveText(field.value || "—");
        dl.append(dt, dd);
      }
      if (dl.children.length) sectionEl.append(dl);
    }

    for (const line of section.body || []) {
      if (compact && sectionEl.querySelectorAll("p").length > 1) break;
      const sanitizedLine = sanitizeSensitiveText(line);
      if (!sanitizedLine) continue;
      const paragraph = document.createElement("p");
      paragraph.textContent = sanitizedLine;
      sectionEl.append(paragraph);
    }
    container.append(sectionEl);
    if (compact && container.children.length >= 2) break;
  }
}

function allUpcomingEvents() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const heroEligible = state.events.filter((event) => !isClubMeeting(event));
  const future = heroEligible.filter((event) => parseDate(event.date) >= today).sort(byDate);
  const recentlyPassed = heroEligible
    .filter((event) => parseDate(event.date) < today)
    .sort((a, b) => byDate(b, a));
  return [...future, ...recentlyPassed].slice(0, HERO_EVENT_LIMIT);
}

function normalizeEvents(events = []) {
  return events
    .map((event) => ({ ...event, date: event.date || event.start_date }))
    .filter((event) => !isHiddenEvent(event))
    .sort(byDate);
}

function isPastEvent(event) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseDate(event.date) < today;
}

function setHeroIndex(index) {
  if (!state.heroEvents.length) return;
  state.heroIndex = (index + state.heroEvents.length) % state.heroEvents.length;
  renderHero();
}

function restartHeroCycle() {
  if (state.heroTimer) window.clearInterval(state.heroTimer);
  if (state.heroEvents.length <= 1) return;
  state.heroTimer = window.setInterval(() => {
    setHeroIndex(state.heroIndex + 1);
  }, HERO_INTERVAL_MS);
}

function renderHero() {
  const featured = state.heroEvents[state.heroIndex] || null;
  const sideEvents = state.heroEvents.slice(0, HERO_EVENT_LIMIT);
  state.featuredEvent = featured || null;
  els.heroUpcoming.innerHTML = "";
  els.heroProgressDots.innerHTML = "";

  if (!featured) {
    els.heroTitle.textContent = "No upcoming events";
    els.heroDate.textContent = "";
    els.heroDescription.textContent = "";
    els.heroButton.disabled = true;
    return;
  }

  const image = eventImage(featured);
  crossfadeHeroImage(image, hasCustomImage(featured));
  els.heroTitle.parentElement.classList.remove("text-fade");
  void els.heroTitle.parentElement.offsetWidth;
  els.heroTitle.parentElement.classList.add("text-fade");
  els.heroEyebrow.textContent = isPastEvent(featured) ? "Spotlight" : "Upcoming";
  els.heroTitle.textContent = sanitizeSensitiveText(featured.event_name);
  els.heroDate.textContent = `${eventDateLabel(featured)} · ${state.heroIndex + 1} of ${state.heroEvents.length}`;
  els.heroDescription.textContent = descriptionSummary(featured, 320);
  els.heroButton.disabled = false;
  restartHeroProgress();

  const fragment = document.createDocumentFragment();
  const dotFragment = document.createDocumentFragment();
  for (let index = 0; index < state.heroEvents.length; index += 1) {
    const dot = document.createElement("span");
    dot.className = "hero-progress-dot";
    dot.classList.toggle("active", index === state.heroIndex);
    dotFragment.append(dot);
  }
  els.heroProgressDots.append(dotFragment);

  for (let index = 0; index < sideEvents.length; index += 1) {
    const event = sideEvents[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hero-event${index === state.heroIndex ? " is-active" : ""}`;
    const date = document.createElement("span");
    date.textContent = eventDateLabel(event);
    const title = document.createElement("strong");
    title.textContent = sanitizeSensitiveText(event.event_name);
    button.append(date, title);
    button.addEventListener("click", () => {
      if (index >= 0) setHeroIndex(index);
      restartHeroCycle();
    });
    fragment.append(button);
  }
  els.heroUpcoming.append(fragment);
}

function restartHeroProgress() {
  els.heroProgressFill.classList.remove("running");
  void els.heroProgressFill.offsetHeight;
  els.heroProgressFill.style.animationDuration = `${HERO_INTERVAL_MS}ms`;
  els.heroProgressFill.classList.add("running");
}

function setHeroLayer(layer, image, customImage) {
  layer.style.backgroundImage = `url("${image}")`;
  layer.classList.toggle("has-image", customImage);
  layer.classList.toggle("default-image", !customImage);
}

function preloadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = src;
    if (image.decode) {
      image.decode().then(resolve).catch(resolve);
    }
  });
}

async function crossfadeHeroImage(image, customImage) {
  const token = ++state.heroTransitionToken;
  const layers = [els.heroMedia, els.heroMediaNext];
  const nextIndex = state.activeHeroLayer === 0 ? 1 : 0;
  const currentLayer = layers[state.activeHeroLayer];
  const nextLayer = layers[nextIndex];

  await preloadImage(image);
  if (token !== state.heroTransitionToken) return;

  if (!state.heroImageReady) {
    setHeroLayer(currentLayer, image, customImage);
    currentLayer.classList.add("active");
    state.heroImageReady = true;
    return;
  }

  setHeroLayer(nextLayer, image, customImage);
  window.requestAnimationFrame(() => {
    if (token !== state.heroTransitionToken) return;
    nextLayer.classList.add("active");
    currentLayer.classList.remove("active");
    state.activeHeroLayer = nextIndex;
  });
}

function openEvent(event) {
  els.dialogDate.textContent = eventDateLabel(event);
  els.dialogTitle.textContent = sanitizeSensitiveText(event.event_name);
  const url = teamappUrl(event);
  if (url) {
    els.dialogTeamappLink.href = url;
    els.dialogTeamappLink.style.display = "inline-flex";
  } else {
    els.dialogTeamappLink.removeAttribute("href");
    els.dialogTeamappLink.style.display = "none";
  }
  renderStructuredDescription(els.dialogDescription, event);
  const image = eventImage(event);
  els.dialogImage.src = image;
  els.dialogImage.alt = sanitizeSensitiveText(event.event_name);
  els.dialogImage.classList.toggle("default-image", !hasCustomImage(event));
  els.dialogImage.style.display = "block";
  els.dialog.showModal();
  els.dialog.scrollTop = 0;
}

function hideHoverCard() {
  els.hoverCard.classList.remove("visible");
  els.hoverCard.setAttribute("aria-hidden", "true");
}

function renderHoverCard(event) {
  const image = eventImage(event);
  els.hoverCard.innerHTML = "";
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = "";
    img.classList.toggle("default-image", !hasCustomImage(event));
    els.hoverCard.append(img);
  }
  const content = document.createElement("div");
  const date = document.createElement("p");
  date.className = "hover-card-date";
  date.textContent = eventDateLabel(event);
  const title = document.createElement("h3");
  title.textContent = sanitizeSensitiveText(event.event_name);
  const description = document.createElement("p");
  description.className = "hover-card-description";
  description.textContent = descriptionSummary(event, 170);
  content.append(date, title, description);
  els.hoverCard.append(content);
}

function positionHoverCard(anchor) {
  const gap = 12;
  const anchorRect = anchor.getBoundingClientRect();
  const cardRect = els.hoverCard.getBoundingClientRect();
  let left = anchorRect.left;
  let top = anchorRect.bottom + gap;

  if (left + cardRect.width > window.innerWidth - gap) {
    left = window.innerWidth - cardRect.width - gap;
  }
  if (top + cardRect.height > window.innerHeight - gap) {
    top = anchorRect.top - cardRect.height - gap;
  }
  els.hoverCard.style.left = `${Math.max(gap, left)}px`;
  els.hoverCard.style.top = `${Math.max(gap, top)}px`;
}

function showHoverCard(event, anchor) {
  renderHoverCard(event);
  els.hoverCard.classList.add("visible");
  els.hoverCard.setAttribute("aria-hidden", "false");
  positionHoverCard(anchor);
}

function renderEventList() {
  const events = filteredEvents();
  els.eventList.innerHTML = "";
  els.status.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  if (!events.length) {
    els.status.textContent = "No events match the current filters.";
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of events) {
    const category = eventCategory(event);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `event-card event-card-${category}`;
    const image = eventImage(event);
    const img = document.createElement("img");
    img.src = image;
    img.classList.toggle("default-image", !hasCustomImage(event));
    img.alt = "";
    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = sanitizeSensitiveText(event.event_name);
    const date = document.createElement("p");
    date.textContent = eventDateLabel(event);
    const description = document.createElement("p");
    description.textContent = descriptionSummary(event, 190);
    content.append(title, date, description);
    card.append(img, content);
    card.addEventListener("click", () => openEvent(event));
    fragment.append(card);
  }
  els.eventList.append(fragment);
}

function renderCalendar() {
  const year = state.shownDate.getFullYear();
  const month = state.shownDate.getMonth();
  els.monthLabel.textContent = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" }).format(state.shownDate);
  syncJumpControls();
  els.calendarGrid.innerHTML = "";

  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);
  const eventsByDate = new Map();
  const rangeEvents = [];
  const ghostSlotsByIndex = new Map();
  const dateKeyToIndex = new Map();
  const fragment = document.createDocumentFragment();
  const cells = [];

  for (let i = 0; i < 42; i += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const key = dateKey(date);

    const cell = document.createElement("div");
    cell.className = "day-cell";
    cell.style.gridColumn = `${(i % 7) + 1} / ${(i % 7) + 2}`;
    cell.style.gridRow = `${Math.floor(i / 7) + 1}`;
    const eventStack = document.createElement("div");
    eventStack.className = "day-events";
    const number = document.createElement("span");
    number.className = "day-number";
    number.textContent = String(date.getDate());
    if (date.getMonth() !== month) cell.classList.add("outside");
    if (key === dateKey(new Date())) cell.classList.add("today");
    cell.append(number, eventStack);
    dateKeyToIndex.set(key, i);
    cells.push({ eventStack, key, index: i });
    fragment.append(cell);
  }

  for (const event of state.events) {
    const start = parseDate(event.start_date || event.date);
    const end = parseDate(event.end_date || event.date);
    const isMultiDayRange =
      !isCourseEvent(event) &&
      event.start_date &&
      event.end_date &&
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime()) &&
      end > start;

    if (isMultiDayRange) {
      if (isExpressionOfInterestEvent(event)) {
        continue;
      }
      const clampedStart = new Date(Math.max(start.getTime(), gridStart.getTime()));
      const clampedEnd = new Date(Math.min(end.getTime(), gridEnd.getTime() - 24 * 60 * 60 * 1000));
      if (clampedEnd >= clampedStart && !Number.isNaN(clampedStart.getTime()) && !Number.isNaN(clampedEnd.getTime())) {
        let startIndex = dateKeyToIndex.get(dateKey(clampedStart));
        const endIndex = dateKeyToIndex.get(dateKey(clampedEnd));
        if (startIndex !== undefined && endIndex !== undefined) {
          while (startIndex <= endIndex) {
            const rowEndIndex = Math.min(endIndex, Math.floor(startIndex / 7) * 7 + 6);
            rangeEvents.push({
              event,
              startIndex,
              endIndex: rowEndIndex,
              rowIndex: Math.floor(startIndex / 7) + 1,
              startCol: (startIndex % 7) + 1,
              endCol: (rowEndIndex % 7) + 1,
            });
            startIndex = rowEndIndex + 1;
          }
        }
      }
      continue;
    }

    const key = event.date || event.start_date;
    if (!eventsByDate.has(key)) eventsByDate.set(key, []);
    eventsByDate.get(key).push(event);
  }

  const sortedRangeEvents = rangeEvents.sort((a, b) =>
    a.rowIndex === b.rowIndex
      ? a.startCol - b.startCol || a.endCol - b.endCol || a.event.event_name.localeCompare(b.event.event_name)
      : a.rowIndex - b.rowIndex,
  );

  const laneStateByDay = new Map();
  for (const rangeEvent of sortedRangeEvents) {
    let lane = 0;
    while (true) {
      let blocked = false;
      for (let index = rangeEvent.startIndex; index <= rangeEvent.endIndex; index += 1) {
        const laneState = laneStateByDay.get(index);
        if (laneState && laneState.has(lane)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      lane += 1;
    }
    for (let index = rangeEvent.startIndex; index <= rangeEvent.endIndex; index += 1) {
      let laneState = laneStateByDay.get(index);
      if (!laneState) {
        laneState = new Set();
        laneStateByDay.set(index, laneState);
      }
      laneState.add(lane);
      const ghostSlots = ghostSlotsByIndex.get(index) || [];
      ghostSlots.push({
        lane,
        eventName: sanitizeSensitiveText(rangeEvent.event.event_name),
      });
      ghostSlotsByIndex.set(index, ghostSlots);
    }
    rangeEvent.lane = lane;
  }

  for (const { eventStack, key, index } of cells) {
    const dayGhostSlots = ghostSlotsByIndex.get(index) || [];
    const ghostLaneSet = new Set(dayGhostSlots.map((slot) => slot.lane));
    const eventByLane = new Map();
    for (const event of (eventsByDate.get(key) || []).slice(0, 4)) {
      let lane = 0;
      while (ghostLaneSet.has(lane) || eventByLane.has(lane)) {
        lane += 1;
      }
      eventByLane.set(lane, event);
    }

    const laneCount = Math.max(
      dayGhostSlots.length ? Math.max(...dayGhostSlots.map((slot) => slot.lane)) + 1 : 0,
      eventByLane.size ? Math.max(...eventByLane.keys()) + 1 : 0,
    );

    for (let lane = 0; lane < laneCount; lane += 1) {
      if (ghostLaneSet.has(lane)) {
        const ghost = document.createElement("span");
        const slot = dayGhostSlots.find((item) => item.lane === lane);
        ghost.className = "mini-event mini-event-ghost";
        ghost.textContent = slot ? slot.eventName : "";
        ghost.title = slot ? slot.eventName : "";
        ghost.setAttribute("aria-hidden", "true");
        ghost.tabIndex = -1;
        eventStack.append(ghost);
      }

      const event = eventByLane.get(lane);
      if (!event) continue;
      const category = eventCategory(event);
      const chip = document.createElement("button");
      chip.className = `mini-event mini-event-${category}`;
      chip.classList.toggle(
        "is-multiday",
        event.start_date &&
          event.end_date &&
          !Number.isNaN(parseDate(event.start_date).getTime()) &&
          !Number.isNaN(parseDate(event.end_date).getTime()) &&
          parseDate(event.end_date) > parseDate(event.start_date),
      );
      chip.type = "button";
      const sanitizedEventName = sanitizeSensitiveText(event.event_name);
      chip.textContent = sanitizedEventName;
      chip.title = sanitizedEventName;
      chip.addEventListener("click", () => openEvent(event));
      chip.addEventListener("mouseenter", () => showHoverCard(event, chip));
      chip.addEventListener("mousemove", () => positionHoverCard(chip));
      chip.addEventListener("mouseleave", hideHoverCard);
      chip.addEventListener("focus", () => showHoverCard(event, chip));
      chip.addEventListener("blur", hideHoverCard);
      eventStack.append(chip);
    }
  }

  for (const rangeEvent of sortedRangeEvents) {
    const chip = document.createElement("button");
    const event = rangeEvent.event;
    const category = eventCategory(event);
    chip.className = `mini-event mini-event-spanning mini-event-${category}`;
    chip.classList.add("is-multiday");
    const sanitizedSpanningEventName = sanitizeSensitiveText(event.event_name);
    chip.type = "button";
    chip.style.gridColumn = `${(rangeEvent.startIndex % 7) + 1} / span ${(rangeEvent.endIndex - rangeEvent.startIndex) + 1}`;
    chip.style.gridRow = `${Math.floor(rangeEvent.startIndex / 7) + 1}`;
    chip.style.setProperty("--event-lane", String(rangeEvent.lane || 0));
    chip.textContent = sanitizedSpanningEventName;
    chip.title = sanitizedSpanningEventName;
    chip.addEventListener("click", () => openEvent(event));
    chip.addEventListener("mouseenter", () => showHoverCard(event, chip));
    chip.addEventListener("mousemove", () => positionHoverCard(chip));
    chip.addEventListener("mouseleave", hideHoverCard);
    chip.addEventListener("focus", () => showHoverCard(event, chip));
    chip.addEventListener("blur", hideHoverCard);
    fragment.append(chip);
  }

  els.calendarGrid.append(fragment);
}

function moveMonth(delta) {
  state.shownDate = new Date(state.shownDate.getFullYear(), state.shownDate.getMonth() + delta, 1);
  renderCalendar();
}

async function boot() {
  try {
    const { data, url } = await fetchCalendar();
    const startYear = Number(data.start_year) || 2026;
    setDefaultMonthFilter();
    state.events = addDefaultClubMeetings(normalizeEvents(data.events || []), startYear);
    const providedHeroEvents = normalizeEvents(data.hero_spotlight_events || []);
    state.heroEvents = providedHeroEvents.length ? providedHeroEvents.slice(0, HERO_EVENT_LIMIT) : allUpcomingEvents();
    state.heroIndex = 0;
    const nextEvent = state.events.find((event) => parseDate(event.date) >= new Date()) || state.events[0];
    if (nextEvent) state.shownDate = new Date(parseDate(nextEvent.date).getFullYear(), parseDate(nextEvent.date).getMonth(), 1);
    renderMonthOptions();
    renderJumpOptions(startYear);
    renderSortButtons();
    renderHero();
    restartHeroCycle();
    renderCalendar();
    renderEventList();
    els.status.textContent = `${filteredEvents().length} events loaded from ${url}`;
  } catch (error) {
    els.status.textContent = `Could not load calendar data: ${error.message}`;
  }
}

els.prevButton.addEventListener("click", () => moveMonth(-1));
els.nextButton.addEventListener("click", () => moveMonth(1));
els.monthLabel.addEventListener("click", toggleMonthJump);
els.jumpMonthSelect.addEventListener("change", jumpToSelectedMonth);
els.jumpYearSelect.addEventListener("change", jumpToSelectedMonth);
document.addEventListener("click", (event) => {
  if (!els.monthJumpPanel.hidden && !event.target.closest(".month-jump")) closeMonthJump();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMonthJump();
});
els.todayButton.addEventListener("click", () => {
  const today = new Date();
  state.shownDate = new Date(today.getFullYear(), today.getMonth(), 1);
  renderCalendar();
});
els.themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderEventList();
});
els.heroButton.addEventListener("click", () => {
  if (state.featuredEvent) openEvent(state.featuredEvent);
});
els.monthSelect.addEventListener("change", (event) => {
  state.monthFilter = event.target.value;
  if (state.monthFilter) state.shownDate = parseDate(`${state.monthFilter}-01`);
  renderCalendar();
  renderEventList();
});
els.sortDateButton.addEventListener("click", () => {
  if (state.listSort === "date") {
    state.listSortDirection = state.listSortDirection === "desc" ? "asc" : "desc";
  } else {
    state.listSort = "date";
    state.listSortDirection = "desc";
  }
  renderSortButtons();
  renderEventList();
});
els.sortNameButton.addEventListener("click", () => {
  if (state.listSort === "name") {
    state.listSortDirection = state.listSortDirection === "asc" ? "desc" : "asc";
  } else {
    state.listSort = "name";
    state.listSortDirection = "asc";
  }
  renderSortButtons();
  renderEventList();
});
els.closeDialog.addEventListener("click", () => els.dialog.close());
window.addEventListener("scroll", hideHoverCard, { passive: true });
window.addEventListener("resize", hideHoverCard);

setTheme(preferredTheme());
boot();
