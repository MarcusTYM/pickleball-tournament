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
  res.sendFile(path.join(__dirname, 'public', 'spectator.html'));
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

// Socket.IO Connections
io.on('connection', (socket) => {
  socket.emit('init', { tournament, activeCourts });

  socket.on('setupTournament', async ({ numTeams, numGroups }) => {
    tournament = createTournament(numTeams, numGroups);
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null }
    };
    await saveData();
    io.emit('update', { tournament, activeCourts });
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
        io.emit('update', { tournament, activeCourts });
      }
    }
  });

  socket.on('assignMatch', async ({ courtNum, matchId }) => {
    const match = tournament.schedule.find(m => m.id === matchId);
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
      io.emit('update', { tournament, activeCourts });
    }
  });

  socket.on('updateScore', async ({ courtNum, scoreA, scoreB }) => {
    if (activeCourts[courtNum]) {
      activeCourts[courtNum].scoreA = scoreA;
      activeCourts[courtNum].scoreB = scoreB;
      const match = tournament.schedule.find(m => m.id === activeCourts[courtNum].matchId);
      if (match) {
        match.scoreA = scoreA;
        match.scoreB = scoreB;
      }
      await saveData();
      io.emit('update', { tournament, activeCourts });
    }
  });

  socket.on('finishMatch', async ({ courtNum }) => {
    const court = activeCourts[courtNum];
    if (court && court.matchId) {
      const match = tournament.schedule.find(m => m.id === court.matchId);
      if (match) {
        match.status = 'COMPLETED';
        match.scoreA = court.scoreA;
        match.scoreB = court.scoreB;
        if (court.startedAt) {
          const durationMin = Math.round((Date.now() - court.startedAt) / 60000);
          match.duration = `${durationMin} mins`;
        }
      }
      activeCourts[courtNum] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null };
      updateStandings();
      await saveData();
      io.emit('update', { tournament, activeCourts });
    }
  });

  socket.on('resetTournament', async () => {
    tournament = { initialized: false, groups: {}, schedule: [], knockout: { generated: false, matches: [] } };
    activeCourts = {
      4: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      5: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null },
      6: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0, startedAt: null }
    };
    await saveData();
    io.emit('update', { tournament, activeCourts });
  });
});

const PORT = process.env.PORT || 3000;
loadInitialData().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});