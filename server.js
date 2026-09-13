const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'tournament_data.json');

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ tournament, activeCourts }, null, 2));
}

function initializeTournament() {
  const groups = { A: [], B: [], C: [] };
  ['A', 'B', 'C'].forEach(g => {
    for (let i = 1; i <= 6; i++) {
      groups[g].push({ id: `${g}${i}`, name: `Pair ${g}${i}`, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0 });
    }
  });

  let schedule = [];
  let matchId = 1;
  ['A', 'B', 'C'].forEach(g => {
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
          scoreA: 0,
          scoreB: 0,
          status: 'UPCOMING',
          court: null
        });
      }
    }
  });

  return { groups, schedule };
}

let tournament;
let activeCourts = {
  1: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  2: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 },
  3: { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    tournament = saved.tournament;
    activeCourts = saved.activeCourts;
  } catch (err) {
    tournament = initializeTournament();
  }
} else {
  tournament = initializeTournament();
  saveData();
}

io.on('connection', (socket) => {
  socket.emit('initData', { tournament, activeCourts });

  // Update Team Name Handler
  socket.on('updateTeamName', ({ group, teamId, newName }) => {
    const groupList = tournament.groups[group];
    const team = groupList.find(t => t.id === teamId);
    if (team) {
      const oldName = team.name;
      team.name = newName;

      // Update name across all schedule matches
      tournament.schedule.forEach(m => {
        if (m.teamAId === teamId) m.teamA = newName;
        if (m.teamBId === teamId) m.teamB = newName;
      });

      // Update name on active courts if currently playing
      for (let c = 1; c <= 3; c++) {
        if (activeCourts[c].teamA === oldName) activeCourts[c].teamA = newName;
        if (activeCourts[c].teamB === oldName) activeCourts[c].teamB = newName;
      }

      saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('assignMatch', ({ matchId, courtId }) => {
    const match = tournament.schedule.find(m => m.id === matchId);
    if (match && match.status === 'UPCOMING') {
      match.status = 'LIVE';
      match.court = courtId;
      activeCourts[courtId] = { matchId: match.id, teamA: match.teamA, teamB: match.teamB, scoreA: 0, scoreB: 0 };
      saveData();
      io.emit('stateUpdated', { tournament, activeCourts });
    }
  });

  socket.on('updateScore', ({ courtId, scoreA, scoreB }) => {
    if (activeCourts[courtId] && activeCourts[courtId].matchId) {
      activeCourts[courtId].scoreA = scoreA;
      activeCourts[courtId].scoreB = scoreB;
      
      const match = tournament.schedule.find(m => m.id === activeCourts[courtId].matchId);
      if (match) {
        match.scoreA = scoreA;
        match.scoreB = scoreB;
      }
      saveData();
      io.emit('scoreUpdated', { courtId, scoreA, scoreB });
    }
  });

  socket.on('finishMatch', ({ courtId }) => {
    const court = activeCourts[courtId];
    if (!court || !court.matchId) return;

    const match = tournament.schedule.find(m => m.id === court.matchId);
    if (match) {
      match.status = 'FINISHED';
      match.scoreA = court.scoreA;
      match.scoreB = court.scoreB;

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
          tA.wins += 1;
          tB.losses += 1;
        } else {
          tB.wins += 1;
          tA.losses += 1;
        }

        groupList.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
      }
    }

    activeCourts[courtId] = { matchId: null, teamA: 'Empty', teamB: 'Empty', scoreA: 0, scoreB: 0 };
    saveData();
    io.emit('stateUpdated', { tournament, activeCourts });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));