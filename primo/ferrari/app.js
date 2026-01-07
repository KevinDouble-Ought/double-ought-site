console.log("✅ RUNNING primo/ferrari/app.js");

// ============================
// ENGINE LOGGER (pasteable)
// ============================
window.ENGINE_LOG = window.ENGINE_LOG || [];
const ENGINE_LOG = window.ENGINE_LOG;

function elog(type, msg, data) {
  ENGINE_LOG.push({
    t: new Date().toISOString(),
    type,
    msg,
    data: data ?? null
  });
}

function elogSnapshot(label, state) {
  try {
    elog("STATE", label, {
      teams: state?.teams?.length ?? null,
      matches: state?.matchesById?.size ?? null,
      wbRounds: state?.rounds?.wb?.length ?? null,
      lbRounds: state?.rounds?.lb?.length ?? null,
      finalsResetEnabled: state?.finalsResetEnabled ?? null,
      championId: state?.championId ?? null
    });
  } catch (e) {
    elog("WARN", "snapshot failed", String(e));
  }
}

window.dumpEngineLog = () => JSON.stringify(ENGINE_LOG, null, 2);
window.clearEngineLog = () => { ENGINE_LOG.length = 0; console.log("[ENGINE_LOG cleared]"); };
window.copyEngineLog = async () => {
  const txt = window.dumpEngineLog();
  await navigator.clipboard.writeText(txt);
  console.log(`[ENGINE_LOG copied] (${txt.length} chars)`);
  return txt.length;
};

// Hard error traps so we SEE failures
window.addEventListener("error", (e) => {
  elog("ERROR", "window.error", { message: e.message, file: e.filename, line: e.lineno, col: e.colno });
});
window.addEventListener("unhandledrejection", (e) => {
  elog("ERROR", "unhandledrejection", String(e.reason));
});

// Click capture (independent of your handlers)
document.addEventListener("click", (e) => {
  const el = e.target?.closest?.("button, [role='button'], .slot, .slot--clickable");
  if (!el) return;
  const id = el.id || el.getAttribute("data-match-id") || el.className || el.tagName;
  const text = (el.innerText || "").trim().slice(0, 60);
  elog("CLICK", id, { text });
}, true);

// Aliases so older code doesn’t crash
function logEvent(type, msg, data) { elog(type, msg, data); }

// ============================
// APP / ENGINE
// ============================

const DATASET_URL = "./data/teams_live.json";
const SAVE_KEY = "ferrari_v2_save";

/** DOM */
const elTeamsList = document.getElementById("teamsList");
const elStartLane = document.getElementById("startLane");
const elWbRounds = document.getElementById("wbRounds");
const elLbRounds = document.getElementById("lbRounds");
const elFinRounds = document.getElementById("finRounds");
const elDebug = document.getElementById("debugOut");
const elChampionBanner = document.getElementById("championBanner");

const elBracketViewport = document.getElementById("bracketViewport");
const elStartLaneContainer = document.getElementById("startLaneContainer");

const elTxtDrawList = document.getElementById("txtDrawList");
const elSelDrawMode = document.getElementById("selDrawMode");
const elBtnGenerateTeams = document.getElementById("btnGenerateTeams");
const elBtnStartTournament = document.getElementById("btnStartTournament");
const elBtnCopyLog = document.getElementById("btnCopyLog");
const elBtnClearLog = document.getElementById("btnClearLog");
const elDrawListHint = document.getElementById("drawListHint");

const elBtnReloadDataset = document.getElementById("btnReloadDataset");
const elBtnRestartBrackets = document.getElementById("btnRestartBrackets");
const elBtnExportSave = document.getElementById("btnExportSave");
const elFileLoadSave = document.getElementById("fileLoadSave");
const elBtnHardResetAll = document.getElementById("btnHardResetAll");

/** State */
const state = {
  drawMode: "team",      // "team" | "snake"
  drawList: [],
  teams: [],
  teamById: new Map(),

  rounds: {
    start: null,
    wb: [],
    lb: [],
    finals: []
  },

  matchesById: new Map(),
  matchNumById: new Map(),
  nextMatchNum: 1,

  lbPool: [],
  finalsResetEnabled: false,
  championId: null
};

// -----------------------------
// Utilities
// -----------------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function memberDisplay(name) {
  const s = String(name ?? "").trim();
  return s.length ? s : "TBD";
}

function computeTeamName(m1, m2) {
  return `${memberDisplay(m1)} / ${memberDisplay(m2)}`;
}

function makeTeamId(seed) {
  return `T${String(seed).padStart(2, "0")}`;
}

function sortTeamIdsBySeed(teamIds) {
  return [...teamIds].sort((a, b) => {
    const ta = state.teamById.get(a);
    const tb = state.teamById.get(b);
    return (ta?.seed ?? 9999) - (tb?.seed ?? 9999);
  });
}

// -----------------------------
// Persistence (minimal for now)
// -----------------------------
function makeSaveObject() {
  const matchDecisions = {};
  for (const m of allMatchesInCreationOrder()) {
    matchDecisions[m.matchId] = {
      decided: !!m.decided,
      decidedByBye: !!m.decidedByBye,
      winnerId: m.winnerId ?? null,
      loserId: m.loserId ?? null
    };
  }
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    drawMode: state.drawMode,
    drawList: [...state.drawList],
    teams: state.teams.map(t => ({
      id: t.id, seed: t.seed, members: [...t.members], name: t.name
    })),
    matchDecisions
  };
}

function autosave() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(makeSaveObject())); }
  catch {}
}

function clearAutosave() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 2) return null;
    return obj;
  } catch {
    return null;
  }
}

// -----------------------------
// Match/Round Model
// -----------------------------
function allMatchesInCreationOrder() {
  return [...state.matchesById.values()].sort((a, b) => {
    const na = state.matchNumById.get(a.matchId) ?? 0;
    const nb = state.matchNumById.get(b.matchId) ?? 0;
    return na - nb;
  });
}

function newMatchId(bracket, roundIndex, localIndex) {
  return `${bracket}-R${roundIndex}-M${localIndex}`;
}

function makeMatch({ matchId, bracket, roundIndex, slotA, slotB }) {
  return {
    matchId, bracket, roundIndex,
    slotA: slotA ?? { teamId: null, fromText: "" },
    slotB: slotB ?? { teamId: null, fromText: "" },
    decided: false,
    decidedByBye: false,
    winnerId: null,
    loserId: null
  };
}

function registerMatch(match) {
  state.matchesById.set(match.matchId, match);
  state.matchNumById.set(match.matchId, state.nextMatchNum++);
}

function matchLabel(matchId) {
  const n = state.matchNumById.get(matchId);
  return n ? `M${n}` : matchId;
}

// -----------------------------
// Tournament Initialization
// -----------------------------
function initEmptyTournament() {
  state.rounds.start = null;
  state.rounds.wb = [];
  state.rounds.lb = [];
  state.rounds.finals = [];
  state.matchesById = new Map();
  state.matchNumById = new Map();
  state.nextMatchNum = 1;
  state.lbPool = [];
  state.finalsResetEnabled = false;
  state.championId = null;
}

function pickLowestSeedTeamId(teamIds) {
  let best = teamIds[0];
  for (const id of teamIds) {
    const t = state.teamById.get(id);
    const b = state.teamById.get(best);
    if ((t?.seed ?? -1) > (b?.seed ?? -1)) best = id; // highest seed number = lowest seed
  }
  return best;
}

function buildRoundFromEntrants({ bracket, title, roundIndex, entrants, defaultFrom }) {
  const ordered = sortTeamIdsBySeed(entrants);
  const matches = [];

  let byeTeamId = null;
  let working = [...ordered];

  if (working.length % 2 === 1) {
    byeTeamId = pickLowestSeedTeamId(working);
    working = working.filter((id) => id !== byeTeamId);
  }

  let localIndex = 1;
  for (let i = 0; i < working.length; i += 2) {
    const a = working[i];
    const b = working[i + 1];

    const m = makeMatch({
      matchId: newMatchId(bracket, roundIndex, localIndex++),
      bracket, roundIndex,
      slotA: { teamId: a, fromText: defaultFrom },
      slotB: { teamId: b, fromText: defaultFrom }
    });
    registerMatch(m);
    matches.push(m);
  }

  if (byeTeamId) {
    const m = makeMatch({
      matchId: newMatchId(bracket, roundIndex, localIndex++),
      bracket, roundIndex,
      slotA: { teamId: byeTeamId, fromText: defaultFrom },
      slotB: { teamId: null, fromText: "BYE" }
    });
    registerMatch(m);
    decideMatchByBye(m, byeTeamId);
    matches.push(m);
  }

  return { title, bracket, roundIndex, matches };
}

function decideMatch(match, winnerId, loserId) {
  match.decided = true;
  match.decidedByBye = false;
  match.winnerId = winnerId;
  match.loserId = loserId;
 logEvent(
  "INFO",
  "MATCH_DECIDED",
  {
    matchId: match.matchId,
    bracket: match.bracket,
    roundIndex: match.roundIndex,
    decidedByBye: match.decidedByBye,
    winnerId: match.winnerId,
    loserId: match.loserId
  }
);

};



function decideMatchByBye(match, winnerId) {
  match.decided = true;
  match.decidedByBye = true;
  match.winnerId = winnerId;
  match.loserId = null;
logEvent(
  "INFO",
  "MATCH_DECIDED",
  {
    matchId: match.matchId,
    bracket: match.bracket,
    roundIndex: match.roundIndex,
    decidedByBye: match.decidedByBye,
    winnerId: match.winnerId,
    loserId: match.loserId
  }
);

};



function recomputeStats() {
  for (const t of state.teams) { t.wins = 0; t.losses = 0; }
  for (const m of allMatchesInCreationOrder()) {
    if (!m.decided) continue;
    if (m.decidedByBye) continue;
    if (!m.winnerId || !m.loserId) continue;
    const w = state.teamById.get(m.winnerId);
    const l = state.teamById.get(m.loserId);
    if (w) w.wins += 1;
    if (l) l.losses += 1;
  }
}

function isEliminated(teamId) {
  const t = state.teamById.get(teamId);
  return (t?.losses ?? 0) >= 2;
}

function reconcileAfterAnyDecision() {
  recomputeStats();

  const existing = new Set(state.lbPool);
  for (const m of allMatchesInCreationOrder()) {
    if (!m.decided) continue;
    if (!m.loserId) continue;
    if (isEliminated(m.loserId)) continue;
    if (m.bracket === "START" || m.bracket === "WB") {
      if (!existing.has(m.loserId)) {
        state.lbPool.push(m.loserId);
        existing.add(m.loserId);
      }
    }
  }
}

function startIsComplete() {
  return state.rounds?.start?.matches?.every(m => m.decided) ?? false;
}

function getStartWinnersLosers() {
  const winners = [];
  const losers = [];

  const start = state.rounds.start;
  if (!start) return { winners, losers };

  for (const m of start.matches) {
    if (!m.decided) continue;
    if (m.winnerId) winners.push(m.winnerId);
    if (m.loserId) losers.push(m.loserId);
  }

  return { winners, losers };
}


function roundIsComplete(round) {
  return round && round.matches.every((m) => m.decided);
}

// Minimal progression (enough to prove buttons work + BYE works):
function initTournamentFromTeams(teams) {
  state.teams = teams.map(t => ({ ...t, wins: 0, losses: 0 }));
  state.teamById = new Map(state.teams.map(t => [t.id, t]));
  initEmptyTournament();

  const entrants = state.teams.map(t => t.id);
  state.rounds.start = buildRoundFromEntrants({
    bracket: "START",
    title: "Start",
    roundIndex: 1,
    entrants,
    defaultFrom: "Seeded"
  });

  reconcileAfterAnyDecision();
  renderAll();
  autosave();
}

function buildNextRoundsFromStart() {
  // Don’t rebuild if already built
  if (state.rounds.wb.length > 0 || state.rounds.lb.length > 0) return;

  const { winners, losers } = getStartWinnersLosers();

  // WB Round 2 from Start winners
  if (winners.length >= 2) {
    const wb2 = buildRoundFromEntrants({
      bracket: "WB",
      title: "WB Round 2",
      roundIndex: 1,
      entrants: winners,
      defaultFrom: "W of Start"
    });

    // Better provenance: map winner -> matchId
    const winnerSrc = new Map();
    for (const m of state.rounds.start.matches) {
      if (m.decided && m.winnerId) winnerSrc.set(m.winnerId, m.matchId);
    }
    for (const m of wb2.matches) {
      if (m.slotA.teamId) m.slotA.fromText = `W of ${matchLabel(winnerSrc.get(m.slotA.teamId) || "?")}`;
      if (m.slotB.teamId) m.slotB.fromText = `W of ${matchLabel(winnerSrc.get(m.slotB.teamId) || "?")}`;
      if (m.slotB.fromText === "BYE") m.slotB.fromText = "BYE";
    }

    state.rounds.wb.push(wb2);
  }

  // LB Round 1 from Start losers
  if (losers.length >= 2) {
    const lb1 = buildRoundFromEntrants({
      bracket: "LB",
      title: "LB Round 1",
      roundIndex: 1,
      entrants: losers,
      defaultFrom: "L of Start"
    });

    const loserSrc = new Map();
    for (const m of state.rounds.start.matches) {
      if (m.decided && m.loserId) loserSrc.set(m.loserId, m.matchId);
    }
    for (const m of lb1.matches) {
      if (m.slotA.teamId) m.slotA.fromText = `L of ${matchLabel(loserSrc.get(m.slotA.teamId) || "?")}`;
      if (m.slotB.teamId) m.slotB.fromText = `L of ${matchLabel(loserSrc.get(m.slotB.teamId) || "?")}`;
      if (m.slotB.fromText === "BYE") m.slotB.fromText = "BYE";
    }

    state.rounds.lb.push(lb1);
  }

  elog("INFO", "Built WB2 and LB1 from Start", {
    wbMatches: state.rounds.wb[0]?.matches?.length ?? 0,
    lbMatches: state.rounds.lb[0]?.matches?.length ?? 0
  });
}


// -----------------------------
// UI Actions
// -----------------------------
function readSetupFromUi() {
  state.drawMode = (elSelDrawMode?.value === "snake") ? "snake" : "team";
  state.drawList = normalizeLines(elTxtDrawList?.value ?? "");
}

function applySetupToUi() {
  if (elSelDrawMode) elSelDrawMode.value = state.drawMode;
  if (elTxtDrawList) elTxtDrawList.value = state.drawList.join("\n");
  if (elDrawListHint) {
    elDrawListHint.textContent =
      "Min teams: 4 (8 players). Max teams: 20 (40 players). Odd player count allowed → last team gets TBD.";
  }
}

function generateTeamsFromDraw(drawList, mode) {
  const players = [...drawList];
  const teamCount = Math.ceil(players.length / 2);

  if (teamCount < 4) throw new Error("Need at least 8 players (4 teams).");
  if (teamCount > 20) throw new Error("Max is 20 teams (40 players).");

  const slots = Array.from({ length: teamCount }, () => ["", ""]);

  if (mode === "team") {
    let p = 0;
    for (let t = 0; t < teamCount; t++) {
      slots[t][0] = players[p++] ?? "";
      slots[t][1] = players[p++] ?? "";
    }
  } else {
    let p = 0;
    for (let t = 0; t < teamCount; t++) slots[t][0] = players[p++] ?? "";
    for (let t = 0; t < teamCount; t++) slots[t][1] = players[p++] ?? "";
  }

  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    const seed = i + 1;
    const id = makeTeamId(seed);
    const m1 = slots[i][0] ?? "";
    const m2 = slots[i][1] ?? "";
    teams.push({
      id,
      seed,
      members: [m1, m2],
      name: computeTeamName(m1, m2),
      wins: 0,
      losses: 0
    });
  }
  return teams;
}

async function loadDataset() {
  elog("FN", "loadDataset BEGIN");
  const res = await fetch(DATASET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${DATASET_URL} (${res.status})`);
  const data = await res.json();

  state.drawMode = (data.drawMode === "snake") ? "snake" : "team";
  state.drawList = Array.isArray(data.drawList) ? data.drawList.map(s => String(s ?? "")) : [];

  const teamsRaw = Array.isArray(data.teams) ? data.teams : [];
  state.teams = teamsRaw.map((t, i) => {
    const seed = Number(t.seed ?? i + 1);
    const id = String(t.id ?? makeTeamId(seed));
    const members = Array.isArray(t.members) ? [String(t.members[0] ?? ""), String(t.members[1] ?? "")] : ["", ""];
    const name = String(t.name ?? computeTeamName(members[0], members[1]));
    return { id, seed, members, name, wins: 0, losses: 0 };
  }).sort((a, b) => a.seed - b.seed);

  state.teamById = new Map(state.teams.map(t => [t.id, t]));
  applySetupToUi();
  initEmptyTournament();
  renderAll();
  elog("INFO", "Loaded dataset", { teams: state.teams.length, draw: state.drawList.length, mode: state.drawMode });
  elog("FN", "loadDataset END");
}

function startTournament() {
  elog("FN", "startTournament BEGIN");
  readSetupFromUi();

  if (!state.teams.length) {
    const teams = generateTeamsFromDraw(state.drawList, state.drawMode);
    state.teams = teams;
    state.teamById = new Map(teams.map(t => [t.id, t]));
  }
  initTournamentFromTeams([...state.teams].sort((a, b) => a.seed - b.seed));
  elogSnapshot("after startTournament", state);
  elog("FN", "startTournament END");
}

function restartBrackets() {
  if (!state.teams.length) return;
  initTournamentFromTeams([...state.teams].sort((a, b) => a.seed - b.seed));
}

function hardResetAll() {
  clearAutosave();
  state.drawMode = "team";
  state.drawList = [];
  state.teams = [];
  state.teamById = new Map();
  initEmptyTournament();
  applySetupToUi();
  renderAll();
}

// -----------------------------
// Rendering
// -----------------------------
function onSlotClick(match, clickedTeamId) {
  if (!match || !clickedTeamId) return;
  if (match.decided) return;

  const aId = match.slotA?.teamId ?? null;
  const bId = match.slotB?.teamId ?? null;

  // Only allow click-decide when BOTH sides are real teams
  if (!aId || !bId) return;

  const winnerId = clickedTeamId;
  const loserId = (winnerId === aId) ? bId : aId;

  decideMatch(match, winnerId, loserId);

reconcileAfterAnyDecision();

// If Start round is fully decided, build WB Round 2 and LB Round 1 (only once)
if (startIsComplete()) {
  buildNextRoundsFromStart();
}

renderAll();
autosave();

elog("DECIDE", match.matchId, { winnerId, loserId });


  elog("DECIDE", match.matchId, { winnerId, loserId });
}

function renderAll() {
  applySetupToUi();
  renderTeams();
  renderBracket();
  renderChampion();
  renderDebug();
  requestAnimationFrame(centerViewportOnStart);
}

function renderTeams() {
  if (!elTeamsList) return;
  elTeamsList.innerHTML = "";

  const teams = [...state.teams].sort((a, b) => a.seed - b.seed);
  for (const t of teams) {
    const alive = t.losses < 2;
    const card = document.createElement("div");
    card.className = `teamCard ${alive ? "teamCard--alive" : "teamCard--dead"}`;
    card.innerHTML = `
      <div class="teamCard__title">
        <span>${escapeHtml(t.name)}</span>
        <span class="muted small">${alive ? "ALIVE" : "ELIMINATED"}</span>
      </div>
      <div class="teamCard__meta">
        <span>Seed ${t.seed}</span>
        <span>Wins: ${t.wins}</span>
        <span>Losses: ${t.losses}</span>
      </div>
    `;
    elTeamsList.appendChild(card);
  }
}

function renderBracket() {
  if (elStartLane) {
    elStartLane.innerHTML = "";
    if (state.rounds.start) elStartLane.appendChild(renderRoundColumn(state.rounds.start));
  }
  if (elWbRounds) elWbRounds.innerHTML = "";
  if (elLbRounds) elLbRounds.innerHTML = "";
  if (elFinRounds) elFinRounds.innerHTML = "";
}

function renderRoundColumn(roundObj) {
  const col = document.createElement("div");
  col.className = "round";

  const title = document.createElement("div");
  title.className = "round__title";
  title.textContent = roundObj.title;
  col.appendChild(title);

  const list = document.createElement("div");
  list.className = "round__list";
  for (const m of roundObj.matches) list.appendChild(renderMatch(m));
  col.appendChild(list);

  return col;
}

function renderMatch(match) {
  const wrap = document.createElement("div");
  wrap.className = "match";

  wrap.innerHTML = `
    <div class="match__head">
      <div class="match__id">Match ${state.matchNumById.get(match.matchId) ?? "?"}</div>
      <div class="match__tag">${escapeHtml(match.matchId)}</div>
    </div>
  `;

  wrap.appendChild(renderSlot(match, match.slotA));
  wrap.appendChild(renderSlot(match, match.slotB));
  return wrap;
}

function renderSlot(match, slot) {
  const teamId = slot?.teamId ?? null;
  const isByeSlot = teamId === null && slot?.fromText === "BYE";
  const isEmpty = teamId === null && !isByeSlot;

  let name = "—";
  let from = slot?.fromText ?? "";
  let meta = "";

  if (isByeSlot) {
    name = "BYE";
    from = "BYE";
  } else if (!isEmpty) {
    const t = state.teamById.get(teamId);
    name = t ? t.name : teamId;
    meta = t ? `Seed ${t.seed}` : "";
  }

  const winner = match.decided && match.winnerId === teamId && teamId;
  const loser = match.decided && match.loserId === teamId && teamId;

  // Clickable only when:
  // - match not decided
  // - this slot is a real team
  // - both slots are real teams
  const clickable =
    !match.decided &&
    !!teamId &&
    !!match.slotA?.teamId &&
    !!match.slotB?.teamId;

  const div = document.createElement("div");
  div.className =
    "slot" +
    (clickable ? " slot--clickable" : "") +
    (winner ? " slot--winner" : "") +
    (loser ? " slot--loser" : "");

  const adv = match.decidedByBye && match.winnerId === teamId ? "ADV (BYE)" : "";

  div.innerHTML = `
    <div class="slot__left">
      <div class="slot__name">${escapeHtml(name)}</div>
      <div class="slot__from">${escapeHtml(adv || from || "")}</div>
    </div>
    <div class="slot__right">
      <div class="slot__meta">${escapeHtml(meta)}</div>
    </div>
  `;

  if (clickable) {
    div.addEventListener("click", () => onSlotClick(match, teamId));
  }

  return div;
}


function renderChampion() {
  if (!elChampionBanner) return;
  if (state.championId) {
    const t = state.teamById.get(state.championId);
    elChampionBanner.style.display = "block";
    elChampionBanner.textContent = `Champion: ${t ? t.name : state.championId}`;
  } else {
    elChampionBanner.style.display = "none";
    elChampionBanner.textContent = "";
  }
}

function renderDebug() {
  if (!elDebug) return;
  elDebug.textContent = JSON.stringify({
    drawMode: state.drawMode,
    drawCount: state.drawList.length,
    teamCount: state.teams.length,
    matches: state.matchesById.size
  }, null, 2);
}

function centerViewportOnStart() {
  if (!elBracketViewport || !elStartLaneContainer) return;
  const viewport = elBracketViewport;
  const start = elStartLaneContainer;
  const targetScrollLeft =
    start.offsetLeft - viewport.clientWidth / 2 + start.offsetWidth / 2;
  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  viewport.scrollLeft = clamp(targetScrollLeft, 0, maxScroll);
}

// -----------------------------
// Wiring (THIS is what makes buttons work)
// -----------------------------
function wireUi() {
  elog("FN", "wireUi BEGIN");

  elBtnGenerateTeams?.addEventListener("click", () => {
    elog("BTN", "Generate Teams");
    try {
      readSetupFromUi();
      const teams = generateTeamsFromDraw(state.drawList, state.drawMode);
      state.teams = teams;
      state.teamById = new Map(teams.map(t => [t.id, t]));
      initEmptyTournament();
      renderAll();
      autosave();
      elog("INFO", "Generated teams", { teamCount: teams.length, mode: state.drawMode });
    } catch (e) {
      elog("ERROR", "Generate Teams failed", { message: e?.message ?? String(e), stack: e?.stack ?? null });
      alert(e?.message ?? String(e));
    }
  });

  elBtnStartTournament?.addEventListener("click", () => {
    elog("BTN", "Start Tournament");
    try {
      startTournament();
    } catch (e) {
      elog("ERROR", "Start Tournament failed", { message: e?.message ?? String(e), stack: e?.stack ?? null });
      alert(e?.message ?? String(e));
    }
  });

  elBtnCopyLog?.addEventListener("click", async () => {
    elog("BTN", "Copy Log");
    try {
      await window.copyEngineLog();
    } catch (e) {
      // fallback: just dump to console
      console.log(window.dumpEngineLog());
      alert("Clipboard blocked. I dumped the log to console instead.");
    }
  });

  elBtnClearLog?.addEventListener("click", () => {
    elog("BTN", "Clear Log");
    window.clearEngineLog();
  });

  elBtnReloadDataset?.addEventListener("click", async () => {
    elog("BTN", "Reload Dataset");
    try { await loadDataset(); autosave(); }
    catch (e) { alert(e?.message ?? String(e)); }
  });

  elBtnRestartBrackets?.addEventListener("click", () => {
    if (!confirm("Restart Brackets? This clears results but keeps teams and draw list.")) return;
    restartBrackets();
  });

  elBtnExportSave?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(makeSaveObject(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ferrari_save_${new Date().toISOString().replaceAll(":", "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  elFileLoadSave?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      // Minimal restore: teams + draw only
      state.drawMode = obj.drawMode === "snake" ? "snake" : "team";
      state.drawList = Array.isArray(obj.drawList) ? obj.drawList : [];
      state.teams = Array.isArray(obj.teams) ? obj.teams.map(t => ({
        id: t.id, seed: t.seed, members: t.members, name: t.name, wins: 0, losses: 0
      })) : [];
      state.teamById = new Map(state.teams.map(t => [t.id, t]));
      initEmptyTournament();
      renderAll();
      autosave();
      elog("INFO", "Loaded save (minimal)", { teams: state.teams.length });
    } catch (err) {
      alert("Failed to load save: " + String(err?.message ?? err));
    } finally {
      e.target.value = "";
    }
  });

  elBtnHardResetAll?.addEventListener("click", () => {
    if (!confirm("Hard Reset All? This clears autosave and wipes everything.")) return;
    hardResetAll();
  });

  elog("FN", "wireUi END");
}

// -----------------------------
// Boot
// -----------------------------
async function boot() {
  elog("FN", "boot BEGIN");
  wireUi();

  const saved = loadAutosave();
  if (saved) {
    // Minimal restore from autosave too
    try {
      state.drawMode = saved.drawMode === "snake" ? "snake" : "team";
      state.drawList = Array.isArray(saved.drawList) ? saved.drawList : [];
      state.teams = Array.isArray(saved.teams) ? saved.teams.map(t => ({
        id: t.id, seed: t.seed, members: t.members, name: t.name, wins: 0, losses: 0
      })) : [];
      state.teamById = new Map(state.teams.map(t => [t.id, t]));
      initEmptyTournament();
      renderAll();
      elog("INFO", "Autosave restored (minimal)", { teams: state.teams.length });
      elog("FN", "boot END");
      return;
    } catch {
      // ignore and continue to dataset
    }
  }

  try {
    await loadDataset();
  } catch (e) {
    elog("WARN", "Dataset load failed; starting empty", String(e));
    applySetupToUi();
    initEmptyTournament();
    renderAll();
  }

  elog("FN", "boot END");
}

boot();
