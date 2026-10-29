const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/spectator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spectator.html'));
});

// Redis initialization
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// State Management
let tournament = { 
  initialized: false, 
  numCourts: 6,
  groups: {}, 
  schedule: [], 
  knockout: { generated: false, matches: [] },
  auditLog: []
};

let activeCourts = {};
function initActiveCourts(numCourts = 6) {
  activeCourts = {};
  for (let i = 1; i <= numCourts; i++) {
    activeCourts[i] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 };
  }
}
initActiveCourts(6);

function addLog(action, details) {
  if (!tournament.auditLog) tournament.auditLog = [];
  tournament.auditLog.unshift({
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Kuala_Lumpur' }),
    action,
    details
  });
}

async function saveData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      await redis.set('tournament_state', JSON.stringify({ tournament, activeCourts }));
    }
  } catch (err) {
    console.error("Error saving to Redis:", err);
  }
}

async function loadInitialData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const data = await redis.get('tournament_state');
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.tournament) {
          tournament = parsed.tournament;
          if (!tournament.auditLog) tournament.auditLog = [];
          if (tournament.numCourts) {
            initActiveCourts(tournament.numCourts);
          }
        }
        if (parsed.activeCourts) activeCourts = parsed.activeCourts;
        console.log("Successfully loaded state from Redis");
      }
    }
  } catch (err) {
    console.error("Error loading state from Redis:", err);
  }
}

function createTournament(numTeams, numGroups, numCourts = 6) {
  const groupNames = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, numGroups);
  const groups = {};
  groupNames.forEach(g => groups[g] = []);

  for (let i = 1; i <= numTeams; i++) {
    const groupIndex = (i - 1) % numGroups;
    const gName = groupNames[groupIndex];
    groups[gName].push({
      id: `${gName}${groups[gName].length + 1}`,
      name: `Pair ${gName}${groups[gName].length + 1}`,
      wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0
    });
  }

  let groupRounds = {};
  groupNames.forEach(g => {
    let teams = [...groups[g]];
    if (teams.length % 2 !== 0) teams.push(null);

    const numRounds = teams.length - 1;
    const half = teams.length / 2;
    groupRounds[g] = [];

    for (let r = 0; r < numRounds; r++) {
      let roundMatches = [];
      for (let i = 0; i < half; i++) {
        const tA = teams[i];
        const tB = teams[teams.length - 1 - i];
        if (tA && tB) roundMatches.push({ teamA: tA, teamB: tB, group: g });
      }
      groupRounds[g].push(roundMatches);
      teams = [teams[0], teams[teams.length - 1], ...teams.slice(1, teams.length - 1)];
    }
  });

  let schedule = [];
  let matchId = 1;
  const maxRounds = Math.max(...Object.values(groupRounds).map(r => r.length));

  for (let r = 0; r < maxRounds; r++) {
    groupNames.forEach(g => {
      if (groupRounds[g][r]) {
        groupRounds[g][r].forEach(m => {
          schedule.push({
            id: matchId++,
            group: m.group,
            teamAId: m.teamA.id,
            teamBId: m.teamB.id,
            teamA: m.teamA.name,
            teamB: m.teamB.name,
            scoreA: 0, scoreB: 0,
            status: 'UPCOMING', court: null, duration: null
          });
        });
      }
    });
  }

  return {
    initialized: true,
    numTeams,
    numGroups,
    numCourts,
    groups,
    schedule,
    knockout: { generated: false, matches: [] },
    auditLog: []
  };
}

function updateStandings() {
  Object.keys(tournament.groups).forEach(g => {
    tournament.groups[g].forEach(t => {
      t.wins = 0; t.losses = 0; t.pointsFor = 0; t.pointsAgainst = 0; t.diff = 0;
    });
  });

  tournament.schedule.forEach(m => {
    if (m.status === 'COMPLETED') {
      const g = m.group;
      const teamA = tournament.groups[g].find(t => t.id === m.teamAId);
      const teamB = tournament.groups[g].find(t => t.id === m.teamBId);

      if (teamA && teamB) {
        teamA.pointsFor += m.scoreA;
        teamA.pointsAgainst += m.scoreB;
        teamB.pointsFor += m.scoreB;
        teamB.pointsAgainst += m.scoreA;

        if (m.scoreA > m.scoreB) {
          teamA.wins += 1;
          teamB.losses += 1;
        } else if (m.scoreB > m.scoreA) {
          teamB.wins += 1;
          teamA.losses += 1;
        }
      }
    }
  });

  Object.keys(tournament.groups).forEach(g => {
    tournament.groups[g].forEach(t => {
      t.diff = t.pointsFor - t.pointsAgainst;
    });
    tournament.groups[g].sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return (b.pointsFor || 0) - (a.pointsFor || 0);
    });
  });
}

function generateKnockoutBracket() {
  updateStandings();

  const groupWinners = [];
  const groupRunnersUp = [];

  Object.keys(tournament.groups).forEach(g => {
    if (tournament.groups[g][0]) groupWinners.push({ ...tournament.groups[g][0], group: g });
    if (tournament.groups[g][1]) groupRunnersUp.push({ ...tournament.groups[g][1], group: g });
  });

  const compareTeams = (a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return (b.pointsFor || 0) - (a.pointsFor || 0);
  };

  groupWinners.sort(compareTeams);
  groupRunnersUp.sort(compareTeams);

  // Collect all group winners first
  let qualified = [...groupWinners];

  // Target size: 4 for <= 4 groups, 8 for 5+ groups
  let targetSize = qualified.length <= 4 ? 4 : 8;
  
  for (let i = 0; i < groupRunnersUp.length && qualified.length < targetSize; i++) {
    qualified.push(groupRunnersUp[i]);
  }

  let matches = [];

  if (qualified.length <= 4) {
    let t1 = qualified[0] || { name: 'Seed 1', group: 'X' };
    let t2 = qualified[1] || { name: 'Seed 2', group: 'Y' };
    let t3 = qualified[2] || { name: 'Seed 3', group: 'Z' };
    let t4 = qualified[3] || { name: 'Seed 4', group: 'W' };

    // PREVENT SAME-GROUP MATCHUPS IN SEMIFINALS
    // If Semifinal 1 (t1 vs t4) has teams from the same group, swap t4 with t3
    if (t1.group === t4.group && t1.group !== t3.group) {
      let temp = t3; t3 = t4; t4 = temp;
    } 
    // If Semifinal 2 (t2 vs t3) has teams from the same group, swap t3 with t4
    else if (t2.group === t3.group && t2.group !== t4.group) {
      let temp = t3; t3 = t4; t4 = temp;
    }

    matches = [
      { id: 101, label: 'Semifinal 1', teamA: t1.name, teamB: t4.name, scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
      { id: 102, label: 'Semifinal 2', teamA: t2.name, teamB: t3.name, scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
      { id: 103, label: '3rd Place Playoff', teamA: 'Loser SF1', teamB: 'Loser SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null },
      { id: 104, label: 'Finals (1st/2nd)', teamA: 'Winner SF1', teamB: 'Winner SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null }
    ];
  } else {
    // 8-team Quarterfinals structure for 5-8 groups
    let qTeams = [];
    for (let i = 0; i < 8; i++) {
      qTeams.push(qualified[i] ? qualified[i].name :