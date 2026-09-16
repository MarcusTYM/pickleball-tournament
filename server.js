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
  groups: {}, 
  schedule: [], 
  knockout: { generated: false, matches: [] },
  auditLog: []
};

let activeCourts = {
  4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
  5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
  6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 }
};

function addLog(action, details) {
  if (!tournament.auditLog) tournament.auditLog = [];
  tournament.auditLog.unshift({
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
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
        }
        if (parsed.activeCourts) activeCourts = parsed.activeCourts;
        console.log("Successfully loaded state from Redis");
      }
    }
  } catch (err) {
    console.error("Error loading state from Redis:", err);
  }
}

function createTournament(numTeams, numGroups) {
  const groupNames = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, numGroups);
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

  const qualified = [...groupWinners];
  for (let i = 0; i < groupRunnersUp.length && qualified.length < 4; i++) {
    qualified.push(groupRunnersUp[i]);
  }

  const team1 = qualified[0] ? qualified[0].name : 'Seed 1';
  const team2 = qualified[1] ? qualified[1].name : 'Seed 2';
  const team3 = qualified[2] ? qualified[2].name : 'Seed 3';
  const team4 = qualified[3] ? qualified[3].name : 'Seed 4';

  const matches = [
    { id: 101, label: 'Semifinal 1', teamA: team1, teamB: team4, scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
    { id: 102, label: 'Semifinal 2', teamA: team2, teamB: team3, scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
    { id: 103, label: '3rd Place Playoff', teamA: 'Loser SF1', teamB: 'Loser SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null },
    { id: 104, label: 'Finals (1st/2nd)', teamA: 'Winner SF1', teamB: 'Winner SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null }
  ];

  tournament.knockout = { generated: true, matches };
}

io.on('connection', (socket) => {
  socket.emit('initData', { tournament, activeCourts });

  socket.on('setupTournament', async ({ numTeams, numGroups }) => {
    tournament = createTournament(numTeams, numGroups);
    addLog('Tournament Setup', `Created with ${numTeams} teams across ${numGroups} groups.`);
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 }
    };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('updateTeamName', async ({ group, teamId, newName }) => {
    if (tournament.groups[group]) {
      const team = tournament.groups[group].find(t => t.id === teamId);
      if (team) {
        const oldName = team.name;
        team.name = newName;
        tournament.schedule.forEach(m => {
          if (m.group === group) {
            if (m.teamAId === teamId) m.teamA = newName;
            if (m.teamBId === teamId) m.teamB = newName;
          }
        });
        addLog('Team Renamed', `[Group ${group}] "${oldName}" updated to "${newName}".`);
        await saveData();
        io.emit('stateUpdated', { tournament, activeCourts });
      }
    }
  });

  socket.on('assignMatch', async (data) => {
    const matchId = data.matchId;
    const courtNum = data.courtId || data.courtNum;

    let match = tournament.schedule.find(m => m.id === matchId);
    if (!match && tournament.knockout && tournament.knockout.matches) {
      match = tournament.knockout.matches.find(m => m.id === matchId);
    }

    if (match) {
      match.status = 'IN_PROGRESS';
      match.court = courtNum;
      activeCourts[courtNum] = {
        matchId: match.id,
        teamA: match.teamA,
        teamB: match.teamB,
        teamAId: match.teamAId,
        teamBId: match.teamBId,
        scoreA: match.scoreA || 0,
        scoreB: match.scoreB || 0,
        startedAt: Date.now(),
        isPaused: false,
        elapsedTime: 0
      };
      addLog('Match Assigned', `Match #${match.id} (${match.teamA} vs ${match.teamB}) assigned to Court ${courtNum}.`);
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('togglePauseTimer', async (data) => {
    const courtNum = data.courtId || data.courtNum;
    const court = activeCourts[courtNum];
    if (court && court.matchId) {
      const now = Date.now();
      if (!court.isPaused) {
        if (court.startedAt) {
          court.elapsedTime = (court.elapsedTime || 0) + Math.floor((now - court.startedAt) / 1000);
        }
        court.isPaused = true;
        court.startedAt = null;
        addLog('Timer Paused', `Court ${courtNum} timer paused.`);
      } else {
        court.isPaused = false;
        court.startedAt = now;
        addLog('Timer Resumed', `Court ${courtNum} timer resumed.`);
      }
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('swapTeams', async (data) => {
    const courtNum = data.courtId || data.courtNum;
    const court = activeCourts[courtNum];

    if (court) {
      if (data.teamA !== undefined && data.teamB !== undefined) {
        court.teamA = data.teamA;
        court.teamB = data.teamB;
        court.scoreA = data.scoreA;
        court.scoreB = data.scoreB;
      } else {
        const tempTeam = court.teamA;
        court.teamA = court.teamB;
        court.teamB = tempTeam;

        const tempScore = court.scoreA;
        court.scoreA = court.scoreB;
        court.scoreB = tempScore;
      }

      const tempId = court.teamAId;
      court.teamAId = court.teamBId;
      court.teamBId = tempId;

      let match = tournament.schedule.find(m => m.id === court.matchId);
      if (!match && tournament.knockout && tournament.knockout.matches) {
        match = tournament.knockout.matches.find(m => m.id === court.matchId);
      }
      if (match) {
        match.teamA = court.teamA;
        match.teamB = court.teamB;
        match.teamAId = court.teamAId;
        match.teamBId = court.teamBId;
        match.scoreA = court.scoreA;
        match.scoreB = court.scoreB;
      }

      addLog('Teams Swapped', `Court ${courtNum} teams swapped.`);
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('updateScore', async (data) => {
    const courtNum = data.courtId || data.courtNum;
    const scoreA = data.scoreA;
    const scoreB = data.scoreB;

    if (activeCourts[courtNum]) {
      activeCourts[courtNum].scoreA = scoreA;
      activeCourts[courtNum].scoreB = scoreB;

      let match = tournament.schedule.find(m => m.id === activeCourts[courtNum].matchId);
      if (!match && tournament.knockout && tournament.knockout.matches) {
        match = tournament.knockout.matches.find(m => m.id === activeCourts[courtNum].matchId);
      }
      if (match) {
        match.scoreA = scoreA;
        match.scoreB = scoreB;
      }
      addLog('Score Updated', `Court ${courtNum}: ${activeCourts[courtNum].teamA} (${scoreA}) - (${scoreB}) ${activeCourts[courtNum].teamB}`);
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
      io.emit('scoreUpdated', { courtId: courtNum, scoreA, scoreB });
    }
  });

  socket.on('finishMatch', async (data) => {
    const courtNum = data.courtId || data.courtNum;
    const court = activeCourts[courtNum];

    if (court && court.matchId) {
      let match = tournament.schedule.find(m => m.id === court.matchId);
      let isKnockout = false;

      if (!match && tournament.knockout && tournament.knockout.matches) {
        match = tournament.knockout.matches.find(m => m.id === court.matchId);
        isKnockout = true;
      }

      if (match) {
        match.status = 'COMPLETED';
        match.scoreA = court.scoreA;
        match.scoreB = court.scoreB;
        
        let totalElapsedSec = court.elapsedTime || 0;
        if (!court.isPaused && court.startedAt) {
          totalElapsedSec += Math.floor((Date.now() - court.startedAt) / 1000);
        }
        const durationMin = Math.max(1, Math.round(totalElapsedSec / 60));
        match.duration = `${durationMin} mins`;

        addLog('Match Finished', `Court ${courtNum}: ${match.teamA} [${match.scoreA}] vs ${match.teamB} [${match.scoreB}] (${match.duration}).`);

        if (isKnockout) {
          const winner = match.scoreA > match.scoreB ? match.teamA : match.teamB;
          const loser = match.scoreA > match.scoreB ? match.teamB : match.teamA;
          match.winner = winner;
          match.loser = loser;

          if (match.id === 101) {
            const sf2 = tournament.knockout.matches.find(m => m.id === 102);
            const finals = tournament.knockout.matches.find(m => m.id === 104);
            const playoff = tournament.knockout.matches.find(m => m.id === 103);
            if (finals) finals.teamA = winner;
            if (playoff) playoff.teamA = loser;
            if (sf2 && sf2.winner) {
              if (finals) finals.status = 'READY';
              if (playoff) playoff.status = 'READY';
            }
          } else if (match.id === 102) {
            const sf1 = tournament.knockout.matches.find(m => m.id === 101);
            const finals = tournament.knockout.matches.find(m => m.id === 104);
            const playoff = tournament.knockout.matches.find(m => m.id === 103);
            if (finals) finals.teamB = winner;
            if (playoff) playoff.teamB = loser;
            if (sf1 && sf1.winner) {
              if (finals) finals.status = 'READY';
              if (playoff) playoff.status = 'READY';
            }
          }
        }
      }

      activeCourts[courtNum] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 };
      updateStandings();
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('generateKnockout', async () => {
    generateKnockoutBracket();
    addLog('Knockout Generated', 'Semifinal and Final brackets generated based on standings.');
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('resetTournament', async () => {
    tournament = { initialized: false, groups: {}, schedule: [], knockout: { generated: false, matches: [] }, auditLog: [] };
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null, isPaused: false, elapsedTime: 0 }
    };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });
});

const PORT = process.env.PORT || 3000;
loadInitialData().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});