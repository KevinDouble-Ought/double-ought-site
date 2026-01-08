console.log("✅ RUNNING primo/ferrari/app.js");

/* =========================================================
   ENGINE LOGGING (simple, safe)
========================================================= */
window.ENGINE_LOG = [];
function elog(type, msg, data = null) {
  window.ENGINE_LOG.push({
    t: new Date().toISOString(),
    type,
    msg,
    data
  });
  console.log(type, msg, data ?? "");
}

/* =========================================================
   STATE
========================================================= */
const state = {
  teams: [],
  teamById: new Map(),

  rounds: {
    start: null,
    wb: [],
    lb: [],
    finals: []
  },

  matchesById: new Map(),
  matchOrder: [],
  championId: null
};

/* =========================================================
   HELPERS
========================================================= */
function makeTeam(id, seed, name) {
  return { id, seed, name, wins: 0, losses: 0 };
}

function makeMatch({ id, bracket, round, slotA, slotB }) {
  return {
    id,
    bracket,
    round,
    slotA,
    slotB,
    decided: false,
    winnerId: null,
    loserId: null
  };
}

function registerMatch(m) {
  state.matchesById.set(m.id, m);
  state.matchOrder.push(m.id);
}

function allMatches() {
  return state.matchOrder.map(id => state.matchesById.get(id));
}

/* =========================================================
   TOURNAMENT SETUP
========================================================= */
function startTournament(teamNames) {
  resetTournament();

  state.teams = teamNames.map((n, i) =>
    makeTeam(`T${i + 1}`, i + 1, n)
  );
  state.teamById = new Map(state.teams.map(t => [t.id, t]));

  buildStartRound();
  render();
}

function resetTournament() {
  state.rounds.start = null;
  state.rounds.wb = [];
  state.rounds.lb = [];
  state.rounds.finals = [];
  state.matchesById.clear();
  state.matchOrder.length = 0;
  state.championId = null;
}

/* =========================================================
   ROUND BUILDERS
========================================================= */
function buildStartRound() {
  const matches = [];

  for (let i = 0; i < state.teams.length; i += 2) {
    const a = state.teams[i];
    const b = state.teams[i + 1];

    const m = makeMatch({
      id: `START-M${matches.length + 1}`,
      bracket: "START",
      round: 1,
      slotA: a.id,
      slotB: b.id
    });

    registerMatch(m);
    matches.push(m);
  }

  state.rounds.start = { title: "Start", matches };
}

function buildWBfromStart() {
  const winners = state.rounds.start.matches.map(m => m.winnerId);
  const m = makeMatch({
    id: "WB-M1",
    bracket: "WB",
    round: 1,
    slotA: winners[0],
    slotB: winners[1]
  });
  registerMatch(m);
  state.rounds.wb.push({ title: "Winners Bracket", matches: [m] });
}

function buildLBfromStart() {
  const losers = state.rounds.start.matches.map(m => m.loserId);
  const m = makeMatch({
    id: "LB-M1",
    bracket: "LB",
    round: 1,
    slotA: losers[0],
    slotB: losers[1]
  });
  registerMatch(m);
  state.rounds.lb.push({ title: "Losers Bracket", matches: [m] });
}

function buildFinals() {
  if (state.rounds.finals.length) return;

  const wbChamp = state.rounds.wb[0].matches[0].winnerId;
  const lbChamp = state.rounds.lb[0].matches[0].winnerId;

  const m1 = makeMatch({
    id: "FINALS-M1",
    bracket: "FINALS",
    round: 1,
    slotA: wbChamp,
    slotB: lbChamp
  });

  registerMatch(m1);
  state.rounds.finals.push({ title: "Finals", matches: [m1] });

  elog("INFO", "Finals built", { wbChamp, lbChamp });
}

function buildFinalsResetIfNeeded(match) {
  if (match.id !== "FINALS-M1") return;

  const wbChamp = match.slotA;

  if (match.winnerId === wbChamp) {
    state.championId = wbChamp;
    elog("INFO", "Champion decided (no reset)", wbChamp);
    return;
  }

  const m2 = makeMatch({
    id: "FINALS-M2",
    bracket: "FINALS",
    round: 2,
    slotA: match.winnerId,
    slotB: match.loserId
  });

  registerMatch(m2);
  state.rounds.finals[0].matches.push(m2);

  elog("INFO", "Finals reset built");
}

/* =========================================================
   MATCH DECISION
========================================================= */
function decide(matchId, winnerId) {
  const m = state.matchesById.get(matchId);
  if (!m || m.decided) return;

  m.decided = true;
  m.winnerId = winnerId;
  m.loserId = (winnerId === m.slotA) ? m.slotB : m.slotA;

  elog("DECIDE", matchId, { winnerId });

  if (matchId.startsWith("START")) {
    if (state.rounds.start.matches.every(x => x.decided)) {
      buildWBfromStart();
      buildLBfromStart();
    }
  }

  if (matchId.startsWith("WB") || matchId.startsWith("LB")) {
    if (
      state.rounds.wb[0].matches[0].decided &&
      state.rounds.lb[0].matches[0].decided
    ) {
      buildFinals();
    }
  }

  if (matchId.startsWith("FINALS")) {
    buildFinalsResetIfNeeded(m);
    if (matchId === "FINALS-M2") {
      state.championId = m.winnerId;
      elog("INFO", "Champion decided (reset)", m.winnerId);
    }
  }

  render();
}

/* =========================================================
   RENDER (VERY BASIC)
========================================================= */
function render() {
  console.clear();
  console.log("=== BRACKET ===");

  dumpRound("Start", state.rounds.start);
  dumpRound("WB", state.rounds.wb[0]);
  dumpRound("LB", state.rounds.lb[0]);
  dumpRound("Finals", state.rounds.finals[0]);

  if (state.championId) {
    console.log("🏆 CHAMPION:", state.teamById.get(state.championId).name);
  }
}

function dumpRound(label, round) {
  if (!round) return;
  console.log(label);
  round.matches.forEach(m => {
    console.log(
      m.id,
      m.decided ? `✔ ${m.winnerId}` : `${m.slotA} vs ${m.slotB}`
    );
  });
}

/* =========================================================
   DEMO BOOTSTRAP (REMOVE LATER)
========================================================= */

