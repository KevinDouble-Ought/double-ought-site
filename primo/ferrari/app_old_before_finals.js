
console.log("✅ USING app.js: SEED-REMOVAL TEST —", new Date().toISOString());
console.log("✅ RUNNING primo/ferrari/app_old_before_finals.js");
console.log("✅ I AM RUNNING: app_old_before_finals.js");


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

// Alias so older code doesn’t crash
function logEvent(type, msg, data) { elog(type, msg, data); }


// ============================
// APP / ENGINE
// ============================
const DATASET_URL = "./data/teams_live.json";
const SAVE_KEY = "ferrari_v2_save";

// NOTE: DO NOT query DOM elements at top-level.
// We do all DOM queries inside wireUi() and render functions.

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

  // Internal progression helpers
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
// Persistence (minimal)
// -----------------------------
function allMatchesInCreationOrder() {
  return [...state.matchesById.values()].sort((a, b) => {
    const na = state.matchNumById.get(a.matchId) ?? 0;
    const nb = state.matchNumById.get(b.matchId) ?? 0;
    return na - nb;
  });
}

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

function getRecommendedMatchId() {
  // Lowest match number that is not yet decided.
  let bestId = null;
  let bestNum = Infinity;

  for (const m of allMatchesInCreationOrder()) {
    if (m.decided) continue;
    const n = state.matchNumById.get(m.matchId);
    if (typeof n !== "number") continue;
    if (n < bestNum) {
      bestNum = n;
      bestId = m.matchId;
    }
  }
  return bestId;
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

function roundIsComplete(round) {
  return !!round && Array.isArray(round.matches) && round.matches.every(m => m.decided);
}


// -----------------------------
// Tournament lifecycle helpers
// -----------------------------
function initEmptyTournament() {
  state.rounds.start = null;
  state.rounds.wb = [];
  state.rounds.lb = [];
  state.rounds.finals = [];

  state.matchesById = new Map();
  state.matchNumById = new Map();
  state.nextMatchNum = 1;

  state.finalsResetEnabled = false;
  state.championId = null;
}

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

function aliveTeamIds() {
  return state.teams
    .filter(t => (t.losses ?? 0) < 2)
    .map(t => t.id);
}

function decideMatch(match, winnerId, loserId) {
  match.decided = true;
  match.decidedByBye = false;
  match.winnerId = winnerId;
  match.loserId = loserId;

  logEvent("INFO", "MATCH_DECIDED", {
    matchId: match.matchId,
    bracket: match.bracket,
    roundIndex: match.roundIndex,
    decidedByBye: match.decidedByBye,
    winnerId: match.winnerId,
    loserId: match.loserId
  });
}

function decideMatchByBye(match, winnerId) {
  match.decided = true;
  match.decidedByBye = true;
  match.winnerId = winnerId;
  match.loserId = null;

function getByeWinnersFromMatches(matches) {
  const out = [];
  for (const m of matches) {
    if (m.decided && m.decidedByBye && m.winnerId) out.push(m.winnerId);
  }


  return out;
}




  logEvent("INFO", "MATCH_DECIDED", {
    matchId: match.matchId,
    bracket: match.bracket,
    roundIndex: match.roundIndex,
    decidedByBye: match.decidedByBye,
    winnerId: match.winnerId,
    loserId: match.loserId
  });
}

function getByeWinnersFromMatches(matches) {
  const out = [];
  for (const m of matches) {
    if (m.decided && m.decidedByBye && m.winnerId) out.push(m.winnerId);
  }
  return out;
}

function moveIdsToFrontPreserveOrder(ids, idsToFront) {
  const frontSet = new Set(idsToFront);
  const front = [];
  const rest = [];
  for (const id of ids) (frontSet.has(id) ? front : rest).push(id);
  return [...front, ...rest];
}


// Build a round from entrants, with BYE support
function pickLowestSeedTeamId(teamIds) {
  let best = teamIds[0];
  for (const id of teamIds) {
    const t = state.teamById.get(id);
    const b = state.teamById.get(best);
    if ((t?.seed ?? -1) > (b?.seed ?? -1)) best = id; // highest seed number = lowest seed
  }
  return best;
}

function buildRoundFromEntrants({ bracket, title, roundIndex, entrants, defaultFrom, preserveOrder = false }) {
  const ordered = preserveOrder ? [...entrants] : sortTeamIdsBySeed(entrants);
  const matches = [];

  let byeTeamId = null;
  let working = [...ordered];

  if (working.length % 2 === 1) {
  byeTeamId = preserveOrder ? working[working.length - 1] : pickLowestSeedTeamId(working);
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


// -----------------------------
// Ferrari progression logic
// -----------------------------
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

// Build WB + initial LB right after Start completes (only once)
function buildNextRoundsFromStart() {
  if (!startIsComplete()) return;
  if (state.rounds.wb.length > 0 || state.rounds.lb.length > 0) return;

  const { winners, losers } = getStartWinnersLosers();

  // WB Round 1 (from Start winners)
  if (winners.length >= 2) {
    const wb1 = buildRoundFromEntrants({
      bracket: "WB",
      title: "WB Round 1",
      roundIndex: 1,
      entrants: moveIdsToFrontPreserveOrder(
  winners,
  getByeWinnersFromMatches(state.rounds.start.matches)
),
preserveOrder: true,

      defaultFrom: "W of Start"
    });

    const winnerSrc = new Map();
    for (const m of state.rounds.start.matches) {
      if (m.decided && m.winnerId) winnerSrc.set(m.winnerId, m.matchId);
    }
    for (const m of wb1.matches) {
      if (m.slotA.teamId) m.slotA.fromText = `W of ${matchLabel(winnerSrc.get(m.slotA.teamId) || "?")}`;
      if (m.slotB.teamId) m.slotB.fromText = `W of ${matchLabel(winnerSrc.get(m.slotB.teamId) || "?")}`;
      if (m.slotB.fromText === "BYE") m.slotB.fromText = "BYE";
    }

    state.rounds.wb.push(wb1);
  }

  // LB Round 1 (from Start losers)
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

  elog("INFO", "Built WB1 and LB1 from Start", {
    wbMatches: state.rounds.wb[0]?.matches?.length ?? 0,
    lbMatches: state.rounds.lb[0]?.matches?.length ?? 0
  });
}

function teamIsInUndecidedMatch(teamId) {
  for (const m of state.matchesById.values()) {
    if (m.decided) continue;
    if (m.slotA?.teamId === teamId) return true;
    if (m.slotB?.teamId === teamId) return true;
  }
  return false;
}

/**
 * ✅ NEW: Build next Winners Bracket round(s)
 * Rule: WB should always contain the undefeated teams.
 * When the last WB round is complete and there are 2+ undefeated teams not already scheduled,
 * create WB Round N+1 from those teams (with BYE support).
 */
function tryBuildNextWbRound() {
    // Once Finals exist (or champion decided), LB should stop building.
  if (state.championId) return;
  if (state.rounds?.finals?.length) return;

  if (!startIsComplete()) return;
  if (!Array.isArray(state.rounds.wb) || state.rounds.wb.length === 0) return;

  const lastWb = state.rounds.wb[state.rounds.wb.length - 1];
  if (!roundIsComplete(lastWb)) return;

  recomputeStats();

  // Undefeated teams only (losses === 0)
  const candidates = state.teams
    .filter(t => (t.losses ?? 0) === 0)
    .map(t => t.id)
    .filter(id => !teamIsInUndecidedMatch(id));

  if (candidates.length < 2) return;

  const nextIndex = state.rounds.wb.length + 1;

  const wb = buildRoundFromEntrants({
    bracket: "WB",
    title: `WB Round ${nextIndex}`,
    roundIndex: nextIndex,
entrants: moveIdsToFrontPreserveOrder(
  candidates,
  getByeWinnersFromMatches((state.rounds.wb[state.rounds.wb.length - 1]?.matches) ?? [])
),
preserveOrder: true,
defaultFrom: "Adv"

  });

  for (const m of wb.matches) {
    if (m.slotB.fromText === "BYE") m.slotB.fromText = "BYE";
  }

  state.rounds.wb.push(wb);

  elog("INFO", "Built next WB round", {
    roundIndex: nextIndex,
    matches: wb.matches.length,
    entrants: candidates.length
  });
}

function tryBuildNextLbRound() {
    // Once Finals exist (or champion decided), LB should stop building.
  if (state.championId) return;
  if (state.rounds?.finals?.length) return;

  if (!startIsComplete()) return;

  const lastLb = state.rounds.lb[state.rounds.lb.length - 1] ?? null;
  if (lastLb && !roundIsComplete(lastLb)) return;

  recomputeStats();

  // LB-eligible = exactly 1 loss (do NOT pull undefeated WB teams into LB)
  const candidates = state.teams
    .filter(t => (t.losses ?? 0) === 1)
    .map(t => t.id)
    .filter(id => !teamIsInUndecidedMatch(id));

  if (candidates.length < 2) return;

  const nextIndex = state.rounds.lb.length + 1;
  const lb = buildRoundFromEntrants({
    bracket: "LB",
    title: `LB Round ${nextIndex}`,
    roundIndex: nextIndex,
  entrants: moveIdsToFrontPreserveOrder(
  candidates,
  getByeWinnersFromMatches((state.rounds.lb[state.rounds.lb.length - 1]?.matches) ?? [])
),
preserveOrder: true,
defaultFrom: "Adv"

  });

  for (const m of lb.matches) {
    if (m.slotB.fromText === "BYE") m.slotB.fromText = "BYE";
  }

  state.rounds.lb.push(lb);

  elog("INFO", "Built next LB round", {
    roundIndex: nextIndex,
    matches: lb.matches.length,
    entrants: candidates.length
  });
}

function tryDeclareChampionBySurvivor() {
  // If Finals exist, Finals marks champ.
  if (finalsBuilt()) return;

  recomputeStats();
  const alive = aliveTeamIds();
  if (alive.length === 1) {
    state.championId = alive[0];
    elog("INFO", "Champion decided (only survivor)", { championId: state.championId });
  }
}


// ============================
// FINALS HELPERS (Ferrari)
// ============================
function finalsBuilt() {
  return Array.isArray(state.rounds.finals) && state.rounds.finals.length > 0;
}

function buildFinalsIfReady() {
  if (finalsBuilt()) return;

  recomputeStats();
  const alive = aliveTeamIds();
  if (alive.length !== 2) return;

  const a = state.teamById.get(alive[0]);
  const b = state.teamById.get(alive[1]);

  const wbChampId = ((a?.losses ?? 99) <= (b?.losses ?? 99)) ? alive[0] : alive[1];
  const lbChampId = (wbChampId === alive[0]) ? alive[1] : alive[0];

  const m1 = makeMatch({
    matchId: newMatchId("FINALS", 1, 1),
    bracket: "FINALS",
    roundIndex: 1,
    slotA: { teamId: wbChampId, fromText: "WB Champ" },
    slotB: { teamId: lbChampId, fromText: "LB Champ" }
  });
  registerMatch(m1);

  state.rounds.finals = [{
    title: "Finals",
    bracket: "FINALS",
    roundIndex: 1,
    matches: [m1]
  }];

  elog("INFO", "Built Finals (Game 1)", { wbChampId, lbChampId });
}

function buildFinalsResetOrChampionIfNeeded() {
  if (!finalsBuilt()) return;

  const finalsRound = state.rounds.finals[0];
  const game1 = finalsRound?.matches?.[0];
  if (!game1?.decided) return;
  if (state.championId) return;

  const wbChampId = game1.slotA?.teamId;

  if (game1.winnerId === wbChampId) {
    state.championId = game1.winnerId;
    elog("INFO", "Champion decided (Finals Game 1)", { championId: state.championId });
    return;
  }

  if (finalsRound.matches.length >= 2) return;

  const m2 = makeMatch({
    matchId: newMatchId("FINALS", 1, 2),
    bracket: "FINALS",
    roundIndex: 1,
    slotA: { teamId: game1.slotA.teamId, fromText: "WB Champ" },
    slotB: { teamId: game1.slotB.teamId, fromText: "LB Champ" }
  });

  registerMatch(m2);
  finalsRound.matches.push(m2);

  elog("INFO", "Built Finals Reset (Game 2)", {
    wbChampId,
    game1Winner: game1.winnerId
  });
}

function declareChampionIfFinalsResetDecided(match) {
  if (match?.bracket !== "FINALS") return;
  if (state.championId) return;

  if (match.matchId.endsWith("-M2") && match.decided && match.winnerId) {
    state.championId = match.winnerId;
    elog("INFO", "Champion decided (Finals Game 2)", {
      championId: state.championId
    });
  }
}


// -----------------------------
// UI Actions
// -----------------------------
function readSetupFromUi() {
  const elSelDrawMode = document.getElementById("selDrawMode");
  const elTxtDrawList = document.getElementById("txtDrawList");

  state.drawMode = (elSelDrawMode?.value === "snake") ? "snake" : "team";
  state.drawList = normalizeLines(elTxtDrawList?.value ?? "");
}

function applySetupToUi() {
  const elSelDrawMode = document.getElementById("selDrawMode");
  const elTxtDrawList = document.getElementById("txtDrawList");
  const elDrawListHint = document.getElementById("drawListHint");

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


// -----------------------------
// Tournament init + controls
// -----------------------------
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
   defaultFrom: ""
  });

  recomputeStats();
  renderAll();
  autosave();
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
renderAll({ center: true });
}


// -----------------------------
// Rendering + Interaction
// -----------------------------
function onSlotClick(match, clickedTeamId) {
  if (!match || !clickedTeamId) return;
  if (match.decided) return;

  const aId = match.slotA?.teamId ?? null;
  const bId = match.slotB?.teamId ?? null;

  if (!aId || !bId) return;

  const winnerId = clickedTeamId;
  const loserId = (winnerId === aId) ? bId : aId;

  decideMatch(match, winnerId, loserId);

  // Update stats
  recomputeStats();

  // Build WB1/LB1 after Start completes
  if (startIsComplete()) {
    buildNextRoundsFromStart();
  }

  // ✅ NEW: Keep WB moving (this is what fixes 6-team / 11-player runs)
  tryBuildNextWbRound();

  // Keep LB moving
  tryBuildNextLbRound();

  // Finals & champion logic
  buildFinalsIfReady();
  buildFinalsResetOrChampionIfNeeded();
  declareChampionIfFinalsResetDecided(match);
  tryDeclareChampionBySurvivor();

  renderAll();
  autosave();

  elog("DECIDE", match.matchId, { winnerId, loserId });
}

function renderAll({ center = false } = {}) {
  applySetupToUi();
  renderTeams();
  renderBracket();
  renderChampion();
  renderDebug();

  if (center) {
    requestAnimationFrame(centerViewportOnStart);
  }
}


function renderTeams() {
  const elTeamsList = document.getElementById("teamsList");
  if (!elTeamsList) return;
  elTeamsList.innerHTML = "";

  const teams = [...state.teams].sort((a, b) => a.seed - b.seed);
  for (const t of teams) {
    const alive = (t.losses ?? 0) < 2;
    const isChampion = !!state.championId && t.id === state.championId;

    const card = document.createElement("div");
    card.className =
      `teamCard ${alive ? "teamCard--alive" : "teamCard--dead"} ${isChampion ? "champion" : ""}`;

    card.innerHTML = `
      <div class="teamCard__title">
        <span>
          ${escapeHtml(t.name)}
          ${isChampion ? ' <span class="champion-badge">🏆</span>' : ""}
        </span>
        <span class="muted small">
  ${isChampion ? "CHAMPION" : (alive ? "ALIVE" : "ELIMINATED")}
</span>

      </div>
 <div class="teamCard__meta">
  <span>Wins: ${t.wins ?? 0}</span>
  <span>Losses: ${t.losses ?? 0}</span>
</div>

    `;
    elTeamsList.appendChild(card);
  }
}

function renderBracket() {
  const elStartLane = document.getElementById("startLane");
  const elWbRounds = document.getElementById("wbRounds");
  const elLbRounds = document.getElementById("lbRounds");
  const elFinRounds = document.getElementById("finalsLane");

  if (elStartLane) {
    elStartLane.innerHTML = "";
    if (state.rounds.start) elStartLane.appendChild(renderRoundColumn(state.rounds.start));
  }

  if (elWbRounds) {
    elWbRounds.innerHTML = "";
    for (const r of (state.rounds.wb || [])) {
      elWbRounds.appendChild(renderRoundColumn(r));
    }
  }

  if (elLbRounds) {
    elLbRounds.innerHTML = "";
    for (const r of (state.rounds.lb || [])) {
      elLbRounds.appendChild(renderRoundColumn(r));
    }
  }

  if (elFinRounds) {
    elFinRounds.innerHTML = "";
    for (const r of (state.rounds.finals || [])) {
      elFinRounds.appendChild(renderRoundColumn(r));
    }
  }
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
  const recommendedId = getRecommendedMatchId();
  if (recommendedId && match.matchId === recommendedId) wrap.classList.add("match--recommended");

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
  const isChampion = !!state.championId && teamId === state.championId;

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
    meta = "";
  }

  const winner = match.decided && match.winnerId === teamId && teamId;
  const loser = match.decided && match.loserId === teamId && teamId;

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
    (loser ? " slot--loser" : "") +
    (isChampion ? " champion" : "");

  const adv = match.decidedByBye && match.winnerId === teamId ? "ADV (BYE)" : "";

  div.innerHTML = `
    <div class="slot__left">
      <div class="slot__name">
        ${escapeHtml(name)}${isChampion ? ' <span class="champion-badge">🏆</span>' : ""}
      </div>
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
  const elChampionBanner = document.getElementById("championBanner");
  if (!elChampionBanner) return;

  if (state.championId) {
    const t = state.teamById.get(state.championId);
    elChampionBanner.style.display = "block";
    elChampionBanner.textContent = `Champion: ${t ? t.name : state.championId} 🏆`;
  } else {
    elChampionBanner.style.display = "none";
    elChampionBanner.textContent = "";
  }
}

function renderDebug() {
  const elDebug = document.getElementById("debugOut");
  if (!elDebug) return;
  elDebug.textContent = JSON.stringify({
    drawMode: state.drawMode,
    drawCount: state.drawList.length,
    teamCount: state.teams.length,
    matches: state.matchesById.size,
    finalsResetEnabled: state.finalsResetEnabled,
    championId: state.championId
  }, null, 2);
}

function centerViewportOnStart() {
  const elBracketViewport = document.getElementById("bracketViewport");
  const elStartLaneContainer = document.getElementById("startLaneContainer");
  if (!elBracketViewport || !elStartLaneContainer) return;

  const viewport = elBracketViewport;
  const start = elStartLaneContainer;
  const targetScrollLeft =
    start.offsetLeft - viewport.clientWidth / 2 + start.offsetWidth / 2;
  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  viewport.scrollLeft = clamp(targetScrollLeft, 0, maxScroll);
}


// -----------------------------
// Wiring (buttons)
// -----------------------------
function wireUi() {
  elog("FN", "wireUi BEGIN");

  const elTxtDrawList = document.getElementById("txtDrawList");
  const elSelDrawMode = document.getElementById("selDrawMode");

  const elBtnGenerateTeams = document.getElementById("btnGenerateTeams");
  const elBtnStartTournament = document.getElementById("btnStartTournament");
  const elBtnCopyLog = document.getElementById("btnCopyLog");
  const elBtnClearLog = document.getElementById("btnClearLog");

  const elBtnReloadDataset = document.getElementById("btnReloadDataset");
  const elBtnRestartBrackets = document.getElementById("btnRestartBrackets");
  const elBtnExportSave = document.getElementById("btnExportSave");
  const elFileLoadSave = document.getElementById("fileLoadSave");
  const elBtnHardResetAll = document.getElementById("btnHardResetAll");

  elBtnGenerateTeams?.addEventListener("click", () => {
    elog("BTN", "Generate Teams");
    try {
      state.drawMode = (elSelDrawMode?.value === "snake") ? "snake" : "team";
      state.drawList = normalizeLines(elTxtDrawList?.value ?? "");

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
      console.log(window.dumpEngineLog());
      alert("Clipboard blocked. I dumped the log to the console.");
    }
  });

  elBtnClearLog?.addEventListener("click", () => {
    elog("BTN", "Clear Log");
    window.clearEngineLog();
  });

  elBtnReloadDataset?.addEventListener("click", async () => {
    elog("BTN", "Reload Dataset");
    try {
      // If you still use loadDataset elsewhere, leave it. Otherwise remove this button.
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
      autosave();

      elog("INFO", "Loaded dataset", { teams: state.teams.length, draw: state.drawList.length, mode: state.drawMode });
    } catch (e) {
      alert(e?.message ?? String(e));
    }
  });

  elBtnRestartBrackets?.addEventListener("click", () => {
    if (!confirm("Restart Brackets? This clears results but keeps teams and draw list.")) return;
    restartBrackets();
    autosave();
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

      state.drawMode = obj.drawMode === "snake" ? "snake" : "team";
      state.drawList = Array.isArray(obj.drawList) ? obj.drawList : [];
      state.teams = Array.isArray(obj.teams) ? obj.teams.map(t => ({
        id: t.id,
        seed: t.seed,
        members: t.members,
        name: t.name,
        wins: 0,
        losses: 0
      })) : [];

      state.teamById = new Map(state.teams.map(t => [t.id, t]));
      initEmptyTournament();
      renderAll({ center: true });
      autosave();

      elog("INFO", "Loaded save (minimal)", { teams: state.teams.length });
    } catch (err) {
      alert("Failed to load save: " + String(err?.message ?? err));
    } finally {
      e.target.value = "";
    }
  });

  elBtnHardResetAll?.addEventListener("click", () => {
    elog("BTN", "Hard Reset All");
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

  const saved = loadAutosave();
  if (saved) {
    try {
      state.drawMode = saved.drawMode === "snake" ? "snake" : "team";
      state.drawList = Array.isArray(saved.drawList) ? saved.drawList : [];
      state.teams = Array.isArray(saved.teams) ? saved.teams.map(t => ({
        id: t.id,
        seed: t.seed,
        members: t.members,
        name: t.name,
        wins: 0,
        losses: 0
      })) : [];
      state.teamById = new Map(state.teams.map(t => [t.id, t]));

      initEmptyTournament();
      renderAll();

      elog("INFO", "Autosave restored (minimal)", { teams: state.teams.length });
      elog("FN", "boot END");
      return;
    } catch {
      // fall through
    }
  }

  applySetupToUi();
  initEmptyTournament();
  renderAll();

  elog("FN", "boot END");
}


// -----------------------------
// Start up ONCE (DOM ready)
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
  wireUi();
  boot();
});
// bye logic WIP