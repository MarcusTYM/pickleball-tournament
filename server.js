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

// Redis initialization for state persistence
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// State Management
let tournament = { 
  initialized: false, 
  groups: {}, 
  schedule: [], 
  knockout: { generated: false, matches: [] } 
};

let activeCourts = {
  4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
  5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
  6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null }
};

// Save state to Redis
async function saveData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      await redis.set('tournament_state', JSON.stringify({ tournament, activeCourts }));
    }
  } catch (err) {
    console.error("Error saving to Redis:", err);
  }
}

// Load state from Redis on startup
async function loadInitialData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const data = await redis.get('tournament_state');
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.tournament) tournament = parsed.tournament;
        if (parsed.activeCourts) activeCourts = parsed.activeCourts;
        console.log("Successfully loaded state from Redis");
      }
    }
  } catch (err) {
    console.error("Error loading state from Redis:", err);
  }
}

// Round-Robin Generator with Rest Interval Interleaving
function createTournament(numTeams, numGroups) {
  const groupNames = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, numGroups);
  const groups = {};
  groupNames.forEach(g => groups[g] = []);

  // 1. Assign pairs evenly to groups
  for (let i = 1; i <= numTeams; i++) {
    const groupIndex = (i - 1) % numGroups;
    const gName = groupNames[groupIndex];
    groups[gName].push({
      id: `${gName}${groups[gName].length + 1}`,
      name: `Pair ${gName}${groups[gName].length + 1}`,
      wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0
    });
  }

  // 2. Generate balanced round-robin rounds per group using the Circle Method
  let groupRounds = {};
  groupNames.forEach(g => {
    let teams = [...groups[g]];
    if (teams.length % 2 !== 0) teams.push(null); // Dummy for odd team counts

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
      // Rotate teams (keep index 0 fixed)
      teams = [teams[0], teams[teams.length - 1], ...teams.slice(1, teams.length - 1)];
    }
  });

  // 3. Interleave round matches across groups to maximize rest between games
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
    knockout: { generated: false, matches: [] }
  };
}

// Recalculate Standings Table
function updateStandings() {
  Object.keys(tournament.groups).forEach(g => {
    tournament.groups[g].forEach(t => {
      t.wins = 0;
      t.losses = 0;
      t.pointsFor = 0;
      t.pointsAgainst = 0;
      t.diff = 0;
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
      return b.diff - a.diff;
    });
  });
}

// Generate Knockout Stage
function generateKnockoutBracket() {
  updateStandings();
  const topTeams = [];
  Object.keys(tournament.groups).forEach(g => {
    if (tournament.groups[g][0]) topTeams.push(tournament.groups[g][0].name);
    if (tournament.groups[g][1]) topTeams.push(tournament.groups[g][1].name);
  });

  const matches = [
    { id: 101, label: 'Semifinal 1', teamA: topTeams[0] || 'Top Group A', teamB: topTeams[3] || 'Runner-Up Group B', scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
    { id: 102, label: 'Semifinal 2', teamA: topTeams[2] || 'Top Group B', teamB: topTeams[1] || 'Runner-Up Group A', scoreA: 0, scoreB: 0, status: 'READY', winner: null, loser: null },
    { id: 103, label: '3rd Place Playoff', teamA: 'Loser SF1', teamB: 'Loser SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null },
    { id: 104, label: 'Finals (1st/2nd)', teamA: 'Winner SF1', teamB: 'Winner SF2', scoreA: 0, scoreB: 0, status: 'WAITING', winner: null, loser: null }
  ];

  tournament.knockout = { generated: true, matches };
}

// Socket.IO Connections
io.on('connection', (socket) => {
  // Emit state on initial connection
  socket.emit('initData', { tournament, activeCourts });

  socket.on('setupTournament', async ({ numTeams, numGroups }) => {
    tournament = createTournament(numTeams, numGroups);
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null }
    };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('updateTeamName', async ({ group, teamId, newName }) => {
    if (tournament.groups[group]) {
      const team = tournament.groups[group].find(t => t.id === teamId);
      if (team) {
        team.name = newName;
        tournament.schedule.forEach(m => {
          if (m.group === group) {
            if (m.teamAId === teamId) m.teamA = newName;
            if (m.teamBId === teamId) m.teamB = newName;
          }
        });
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
        scoreA: match.scoreA || 0,
        scoreB: match.scoreB || 0,
        startedAt: Date.now()
      };
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
        if (court.startedAt) {
          const durationMin = Math.round((Date.now() - court.startedAt) / 60000);
          match.duration = `${durationMin} mins`;
        }

        if (isKnockout) {
          const winner = match.scoreA > match.scoreB ? match.teamA : match.teamB;
          const loser = match.scoreA > match.scoreB ? match.teamB : match.teamA;
          match.winner = winner;
          match.loser = loser;

          // Update Finals / 3rd Place dependencies
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

      activeCourts[courtNum] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null };
      updateStandings();
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('generateKnockout', async () => {
    generateKnockoutBracket();
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('resetTournament', async () => {
    tournament = { initialized: false, groups: {}, schedule: [], knockout: { generated: false, matches: [] } };
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null }
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