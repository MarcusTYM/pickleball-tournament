const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/spectator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spectator.html'));
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

async function saveData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      await redis.set('tournament_state', JSON.stringify({ tournament, activeCourts }));
    }
  } catch (err) {
    console.error("Error saving to Redis:", err);
  }
}

let tournament = { initialized: false, groups: {}, schedule: [], knockout: { generated: false, matches: [] } };
let activeCourts = {
  1: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  2: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  3: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 }
};

function createDynamicTournament(numTeams, numGroups) {
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

  let schedule = [];
  let matchId = 1;
  groupNames.forEach(g => {
    const teams = groups[g];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        schedule.push({
          id: matchId++,
          group: g,
          teamAId: teams[i].id,
          teamBId: teams[j].id,
          teamA: teams[i].name,
          teamB: teams[j].name,
          scoreA: 0, scoreB: 0,
          status: 'UPCOMING', court: null
        });
      }
    }
  });

  return {
    initialized: true,
    numTeams,
    numGroups,
    groups,
    schedule,
    knockout: { generated: false, matches: [] }
  };
}

async function loadInitialData() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL) {
      const saved = await redis.get('tournament_state');
      if (saved) {
        const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
        tournament = parsed.tournament;
        activeCourts = parsed.activeCourts;
      }
    }
  } catch (err) {
    console.error("Failed to load Redis data:", err);
  }
}
loadInitialData();

io.on('connection', (socket) => {
  socket.emit('initData', { tournament, activeCourts });

  socket.on('setupTournament', async ({ numTeams, numGroups }) => {
    tournament = createDynamicTournament(parseInt(numTeams), parseInt(numGroups));
    activeCourts = {
      1: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
      2: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
      3: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 }
    };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('resetTournament', async () => {
    tournament = { initialized: false, groups: {}, schedule: [], knockout: { generated: false, matches: [] } };
    activeCourts = {
      1: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
      2: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
      3: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 }
    };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('generateKnockout', async () => {
    const groupKeys = Object.keys(tournament.groups);
    let topTeams = [];
    
    groupKeys.forEach(g => {
      if (tournament.groups[g][0]) topTeams.push(tournament.groups[g][0]);
    });

    if (groupKeys.length === 3) {
      const secondPlaces = groupKeys.map(g => tournament.groups[g][1]).filter(Boolean);
      secondPlaces.sort((a, b) => b.wins - a.wins || b.diff - a.diff || b.pointsFor - a.pointsFor);
      if (secondPlaces[0]) topTeams.push(secondPlaces[0]);
    }

    if (topTeams.length < 4) return;

    tournament.knockout = {
      generated: true,
      matches: [
        { id: 101, label: 'Semifinal 1', teamA: topTeams[0].name, teamB: topTeams[3].name, scoreA: 0, scoreB: 0, status: 'UPCOMING', court: null, winner: null },
        { id: 102, label: 'Semifinal 2', teamA: topTeams[1].name, teamB: topTeams[2].name, scoreA: 0, scoreB: 0, status: 'UPCOMING', court: null, winner: null },
        { id: 103, label: 'Championship Final', teamA: 'Winner Semi 1', teamB: 'Winner Semi 2', scoreA: 0, scoreB: 0, status: 'WAITING', court: null, winner: null }
      ]
    };

    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });

  socket.on('updateTeamName', async ({ group, teamId, newName }) => {
    const groupList = tournament.groups[group];
    const team = groupList.find(t => t.id === teamId);
    if (team) {
      const oldName = team.name;
      team.name = newName;
      tournament.schedule.forEach(m => {
        if (m.teamAId === teamId) m.teamA = newName;
        if (m.teamBId === teamId) m.teamB = newName;
      });
      for (let c = 1; c <= 3; c++) {
        if (activeCourts[c].teamA === oldName) activeCourts[c].teamA = newName;
        if (activeCourts[c].teamB === oldName) activeCourts[c].teamB = newName;
      }
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('assignMatch', async ({ matchId, courtId }) => {
    let match = tournament.schedule.find(m => m.id === matchId);
    if (!match && tournament.knockout.generated) {
      match = tournament.knockout.matches.find(m => m.id === matchId);
    }
    if (match && (match.status === 'UPCOMING' || match.status === 'READY')) {
      match.status = 'LIVE';
      match.court = courtId;
      activeCourts[courtId] = { matchId: match.id, teamA: match.teamA, teamB: match.teamB, scoreA: 0, scoreB: 0 };
      await saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('updateScore', async ({ courtId, scoreA, scoreB }) => {
    if (activeCourts[courtId] && activeCourts[courtId].matchId) {
      activeCourts[courtId].scoreA = scoreA;
      activeCourts[courtId].scoreB = scoreB;
      let match = tournament.schedule.find(m => m.id === activeCourts[courtId].matchId);
      if (!match && tournament.knockout.generated) {
        match = tournament.knockout.matches.find(m => m.id === activeCourts[courtId].matchId);
      }
      if (match) {
        match.scoreA = scoreA;
        match.scoreB = scoreB;
      }
      await saveData();
      io.emit('scoreUpdated', { courtId, scoreA, scoreB });
    }
  });

  socket.on('finishMatch', async ({ courtId }) => {
    const court = activeCourts[courtId];
    if (!court || !court.matchId) return;

    let match = tournament.schedule.find(m => m.id === court.matchId);
    let isKnockout = false;
    if (!match && tournament.knockout.generated) {
      match = tournament.knockout.matches.find(m => m.id === court.matchId);
      isKnockout = true;
    }

    if (match) {
      match.status = 'FINISHED';
      match.scoreA = court.scoreA;
      match.scoreB = court.scoreB;

      if (!isKnockout) {
        const groupList = tournament.groups[match.group];
        const tA = groupList.find(t => t.id === match.teamAId);
        const tB = groupList.find(t => t.id === match.teamBId);

        if (tA && tB) {
          tA.pointsFor += court.scoreA;
          tA.pointsAgainst += court.scoreB;
          tB.pointsFor += court.scoreB;
          tB.pointsAgainst += court.scoreA;
          tA.diff = tA.pointsFor - tA.pointsAgainst;
          tB.diff = tB.pointsFor - tB.pointsAgainst;

          if (court.scoreA > court.scoreB) {
            tA.wins += 1; tB.losses += 1;
          } else {
            tB.wins += 1; tA.losses += 1;
          }
          groupList.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
        }
      } else {
        match.winner = court.scoreA > court.scoreB ? match.teamA : match.teamB;
        const semi1 = tournament.knockout.matches.find(m => m.id === 101);
        const semi2 = tournament.knockout.matches.find(m => m.id === 102);
        const finalMatch = tournament.knockout.matches.find(m => m.id === 103);

        if (semi1.winner) finalMatch.teamA = semi1.winner;
        if (semi2.winner) finalMatch.teamB = semi2.winner;
        if (semi1.winner && semi2.winner && finalMatch.status === 'WAITING') {
          finalMatch.status = 'UPCOMING';
        }
      }
    }

    activeCourts[courtId] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 };
    await saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));