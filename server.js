require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e7,
  transports: ['websocket', 'polling']
});

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://het:het123@cluster0.mongodb.net/stealth_chat?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB successfully."))
  .catch((err) => console.log("MongoDB connection fallback to memory:", err.message));

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  senderRole: { type: String, required: true },
  encryptedText: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  flaggedPending: { type: Boolean, default: false },
  isSeen: { type: Boolean, default: false },
  isMedia: { type: Boolean, default: false },
  mediaOpened: { type: Boolean, default: false },
  reaction: { type: String, default: null },
  replyRefId: { type: String, default: null }
});

const Message = mongoose.model('Message', messageSchema);
const memoryMessages = [];

const globalSyncState = {
  connected: false,
  videoId: null,
  title: null,
  state: 'PAUSE',
  currentTime: 0,
  lastUpdated: Date.now()
};

function getAccurateSyncTime() {
  if (globalSyncState.state === 'PLAY' && globalSyncState.lastUpdated) {
    const elapsed = (Date.now() - globalSyncState.lastUpdated) / 1000;
    return Math.max(0, globalSyncState.currentTime + elapsed);
  }
  return globalSyncState.currentTime;
}

const codexCinemaState = {
  engine: 'gofile',
  url: '',
  ytId: '',
  embedUrl: '',
  imdbId: '',
  state: 'PAUSE',
  currentTime: 0,
  lastUpdated: Date.now()
};

const scheduledAlerts = [];

app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat & Arcade Engine v13" });
});

app.get('/api/yt-suggest', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data[1] || []);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/yt-search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ videoId: null });
  const directMatch = query.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=[&?]?|v=)([a-zA-Z0-9_-]{11})/);
  if (directMatch && directMatch[1]) {
    return res.json({ videoId: directMatch[1], title: query });
  }
  res.json({ videoId: null, title: query });
});

io.on('connection', (socket) => {
  socket.on('join_room', async ({ room, role }) => {
    socket.join(room);
    socket.roomName = room;

    try {
      let history = [];
      if (mongoose.connection.readyState === 1) {
        history = await Message.find({ room }).sort({ timestamp: 1 }).lean();
      } else {
        history = memoryMessages.filter(m => m.room === room);
      }
      socket.emit('load_history', history);
    } catch (error) {
      console.error("Error loading chat history:", error);
    }

    if (globalSyncState.connected && globalSyncState.videoId) {
      socket.emit('sync_restore_state', {
        connected: true,
        videoId: globalSyncState.videoId,
        title: globalSyncState.title,
        state: globalSyncState.state,
        currentTime: getAccurateSyncTime(),
        timestamp: Date.now()
      });
    }

    if (codexCinemaState.url || codexCinemaState.ytId || codexCinemaState.embedUrl || codexCinemaState.engine === 'local') {
      socket.emit('codex_restore_state', codexCinemaState);
    }

    if (role === 'parent') {
      const sanitized = scheduledAlerts
        .filter(j => j.room === room)
        .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
      socket.emit('scheduled_jobs_update', sanitized);
    }
  });

  socket.on('typing_start', (data) => {
    const role = (data && data.role) || '';
    io.emit('peer_typing_status', { isTyping: true, senderRole: role });
  });

  socket.on('typing_stop', (data) => {
    const role = (data && data.role) || '';
    io.emit('peer_typing_status', { isTyping: false, senderRole: role });
  });

  // MULTIPLAYER ARCADE HANDSHAKE & GAME ACTION RELAYS
  socket.on('admin_send_arcade_request', () => {
    socket.broadcast.emit('arcade_request_received');
  });

  socket.on('user_accept_arcade_request', () => {
    io.emit('toggle_arcade_plugins', true);
  });

  socket.on('admin_toggle_arcade', (status) => {
    io.emit('toggle_arcade_plugins', status);
  });

  socket.on('launch_multiplayer_game', (gameObj) => {
    io.emit('launch_game_session', gameObj);
  });

  socket.on('arcade_game_action', (moveData) => {
    socket.broadcast.emit('arcade_game_action_broadcast', moveData);
  });

  socket.on('sync_send_invite', ({ role }) => {
    socket.broadcast.emit('sync_receive_invite', { fromRole: role });
  });

  socket.on('sync_confirm_invite', () => {
    globalSyncState.connected = true;
    io.emit('sync_connected_event', {
      connected: true,
      videoId: globalSyncState.videoId,
      title: globalSyncState.title,
      state: globalSyncState.state
    });
  });

  socket.on('sync_disconnect_invite', () => {
    globalSyncState.connected = false;
    globalSyncState.videoId = null;
    globalSyncState.title = null;
    globalSyncState.state = 'PAUSE';
    globalSyncState.currentTime = 0;
    io.emit('sync_disconnected_event');
  });

  socket.on('sync_track_change', ({ videoId, title }) => {
    globalSyncState.connected = true;
    globalSyncState.videoId = videoId;
    globalSyncState.title = title;
    globalSyncState.state = 'PLAY';
    globalSyncState.currentTime = 0;
    globalSyncState.lastUpdated = Date.now();
    io.emit('sync_track_update', { videoId, title });
  });

  socket.on('sync_playback_state', ({ state, currentTime, timestamp }) => {
    globalSyncState.state = state;
    globalSyncState.currentTime = currentTime || 0;
    globalSyncState.lastUpdated = timestamp || Date.now();
    socket.broadcast.emit('sync_playback_update', { 
      state, 
      currentTime: globalSyncState.currentTime, 
      timestamp: globalSyncState.lastUpdated 
    });
  });

  socket.on('codex_movie_load', ({ engine, url, ytId, embedUrl, imdbId, senderRole }) => {
    codexCinemaState.engine = engine;
    codexCinemaState.url = url || '';
    codexCinemaState.ytId = ytId || '';
    codexCinemaState.embedUrl = embedUrl || '';
    codexCinemaState.imdbId = imdbId || '';
    codexCinemaState.state = engine === 'youtube' ? 'PLAY' : 'PAUSE';
    codexCinemaState.currentTime = 0;
    codexCinemaState.lastUpdated = Date.now();
    io.emit('codex_movie_load_broadcast', { engine, url, ytId, embedUrl, imdbId, senderRole });
  });

  socket.on('codex_movie_sync', ({ state, currentTime, timestamp }) => {
    codexCinemaState.state = state;
    codexCinemaState.currentTime = currentTime || 0;
    codexCinemaState.lastUpdated = timestamp || Date.now();
    socket.broadcast.emit('codex_movie_sync_broadcast', { 
      state, 
      currentTime: codexCinemaState.currentTime, 
      timestamp: codexCinemaState.lastUpdated 
    });
  });

  socket.on('send_stealth_msg', async (data) => {
    const { room, role, encryptedText, isMedia, replyRefId } = data;
    io.emit('peer_typing_status', { isTyping: false });

    const newMsgData = {
      _id: new mongoose.Types.ObjectId().toString(),
      room,
      senderRole: role,
      encryptedText,
      timestamp: new Date(),
      flaggedPending: false,
      isSeen: false,
      isMedia: Boolean(isMedia),
      mediaOpened: false,
      reaction: null,
      replyRefId: replyRefId || null
    };

    io.to(room).emit('receive_stealth_msg', newMsgData);

    try {
      if (mongoose.connection.readyState === 1) {
        Message.create(newMsgData).catch(console.error);
      } else {
        memoryMessages.push(newMsgData);
      }
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  socket.on('mark_seen', async ({ room, viewerRole }) => {
    io.to(room).emit('messages_marked_seen', { viewerRole });
    memoryMessages.forEach(m => {
      if (m.room === room && m.senderRole !== viewerRole) {
        m.isSeen = true;
      }
    });
    if (mongoose.connection.readyState === 1) {
      Message.updateMany(
        { room, senderRole: { $ne: viewerRole }, isSeen: false },
        { $set: { isSeen: true } }
      ).catch(console.error);
    }
  });

  socket.on('mark_media_opened', async ({ room, messageId }) => {
    io.to(room).emit('media_marked_opened', { messageId });
  });

  socket.on('destroy_view_once', async ({ room, messageId }) => {
    io.to(room).emit('message_destroyed_on_view', { messageId });
  });

  socket.on('add_reaction', async ({ room, messageId, reaction }) => {
    io.to(room).emit('update_message_reaction', { messageId, reaction });
  });

  socket.on('toggle_pending', async ({ messageId, status, room }) => {
    io.to(room).emit('update_msg_status', { messageId, flaggedPending: status });
  });

  socket.on('disconnect', () => {
    io.emit('peer_typing_status', { isTyping: false });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);
});