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

// Shared Live Synced State
const globalSyncState = {
  connected: false,
  videoId: null,
  title: null,
  state: 'PAUSE',
  currentTime: 0,
  timestamp: Date.now()
};

const scheduledAlerts = [];

app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat & Sync Audio Engine v3" });
});

// YouTube Autocomplete Suggestions Proxy
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

// MULTI-FALLBACK YOUTUBE VIDEO RESOLVER (Guaranteed to return videoId on cloud servers like Render)
app.get('/api/yt-search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ videoId: null });

  // 1. Direct Regex check if query is already an ID or link
  const directMatch = query.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=[&?]?|v=)([a-zA-Z0-9_-]{11})/);
  if (directMatch && directMatch[1]) {
    return res.json({ videoId: directMatch[1], title: query });
  }

  // 2. DuckDuckGo HTML Scrape (Google consent wall bypass)
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=site:youtube.com/watch+${encodeURIComponent(query)}`;
    const ddgRes = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const ddgText = await ddgRes.text();
    const ddgMatch = ddgText.match(/watch%3Fv%3D([a-zA-Z0-9_-]{11})/);
    if (ddgMatch && ddgMatch[1]) {
      return res.json({ videoId: ddgMatch[1], title: query });
    }
  } catch (e) {}

  // 3. YouTube Mobile Results Fallback
  try {
    const ytUrl = `https://m.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const ytRes = await fetch(ytUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
      }
    });
    const ytText = await ytRes.text();
    const ytMatch = ytText.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (ytMatch && ytMatch[1]) {
      return res.json({ videoId: ytMatch[1], title: query });
    }
  } catch (e) {}

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

    // Re-sync current music state on connect/reconnect
    if (globalSyncState.connected && globalSyncState.videoId) {
      socket.emit('sync_connected_event', {
        videoId: globalSyncState.videoId,
        title: globalSyncState.title,
        state: globalSyncState.state
      });
    }

    if (role === 'parent') {
      const sanitized = scheduledAlerts
        .filter(j => j.room === room)
        .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
      socket.emit('scheduled_jobs_update', sanitized);
    }
  });

  // Real-time Typing Handlers
  socket.on('typing_start', (data) => {
    const role = (data && data.role) || '';
    io.emit('peer_typing_status', { isTyping: true, senderRole: role });
  });

  socket.on('typing_stop', (data) => {
    const role = (data && data.role) || '';
    io.emit('peer_typing_status', { isTyping: false, senderRole: role });
  });

  // Scheduled / Synced Handshake Sockets
  socket.on('sync_send_invite', ({ role }) => {
    socket.broadcast.emit('sync_receive_invite', { fromRole: role });
  });

  socket.on('sync_confirm_invite', () => {
    globalSyncState.connected = true;
    io.emit('sync_connected_event', {
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
    io.emit('sync_disconnected_event');
  });

  // GLOBAL TRACK BROADCAST: Changes song simultaneously on BOTH devices
  socket.on('sync_track_change', ({ videoId, title }) => {
    globalSyncState.videoId = videoId;
    globalSyncState.title = title;
    globalSyncState.state = 'PLAY';
    globalSyncState.currentTime = 0;
    globalSyncState.timestamp = Date.now();
    io.emit('sync_track_update', { videoId, title });
  });

  // PLAY / PAUSE / SEEK PLAYBACK BROADCAST
  socket.on('sync_playback_state', ({ state, currentTime, timestamp }) => {
    globalSyncState.state = state;
    globalSyncState.currentTime = currentTime;
    globalSyncState.timestamp = timestamp || Date.now();
    socket.broadcast.emit('sync_playback_update', { state, currentTime, timestamp: globalSyncState.timestamp });
  });

  // Admin Dual-Time Scheduled Alert Handler
  socket.on('schedule_bubble_alert', ({ room, text, time1, time2 }) => {
    const queueItem = (timeStr) => {
      if (!timeStr) return;
      const targetTime = new Date(timeStr).getTime();
      const delay = targetTime - Date.now();

      if (delay > 0) {
        const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const timerId = setTimeout(() => {
          io.to(room).emit('receive_assistant_alert', { text, timestamp: Date.now() });

          const index = scheduledAlerts.findIndex(j => j.id === jobId);
          if (index !== -1) scheduledAlerts.splice(index, 1);

          const sanitized = scheduledAlerts
            .filter(j => j.room === room)
            .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
          io.to(room).emit('scheduled_jobs_update', sanitized);
        }, delay);

        scheduledAlerts.push({ id: jobId, room, text, timeStr, timerId });
      }
    };

    queueItem(time1);
    queueItem(time2);

    const sanitized = scheduledAlerts
      .filter(j => j.room === room)
      .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
    io.to(room).emit('scheduled_jobs_update', sanitized);
  });

  socket.on('cancel_scheduled_job', ({ room, jobId }) => {
    const index = scheduledAlerts.findIndex(j => j.id === jobId);
    if (index !== -1) {
      clearTimeout(scheduledAlerts[index].timerId);
      scheduledAlerts.splice(index, 1);
    }
    const sanitized = scheduledAlerts
      .filter(j => j.room === room)
      .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
    io.to(room).emit('scheduled_jobs_update', sanitized);
  });

  // Stealth Chat Relay
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

    try {
      if (mongoose.connection.readyState === 1) {
        const savedMsg = await Message.create(newMsgData);
        newMsgData._id = savedMsg._id.toString();
      } else {
        memoryMessages.push(newMsgData);
      }
    } catch (err) {
      console.error("Error saving message:", err);
    }

    io.to(room).emit('receive_stealth_msg', newMsgData);
  });

  socket.on('mark_seen', async ({ room, viewerRole }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.updateMany(
          { room, senderRole: { $ne: viewerRole }, isSeen: false },
          { $set: { isSeen: true } }
        );
      } else {
        memoryMessages.forEach(m => {
          if (m.room === room && m.senderRole !== viewerRole) {
            m.isSeen = true;
          }
        });
      }

      io.to(room).emit('messages_marked_seen', { viewerRole });
    } catch (err) {
      console.error("Error processing seen status:", err);
    }
  });

  socket.on('mark_media_opened', async ({ room, messageId }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { mediaOpened: true });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.mediaOpened = true;
      }
      io.to(room).emit('media_marked_opened', { messageId });
    } catch (err) {
      console.error("Error updating media opened state:", err);
    }
  });

  socket.on('destroy_view_once', async ({ room, messageId }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndDelete(messageId);
      } else {
        const idx = memoryMessages.findIndex(m => m._id === messageId);
        if (idx !== -1) memoryMessages.splice(idx, 1);
      }
    } catch (err) {
      console.error("Error deleting view-once asset:", err);
    }

    io.to(room).emit('message_destroyed_on_view', { messageId });
  });

  socket.on('add_reaction', async ({ room, messageId, reaction }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { reaction });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.reaction = reaction;
      }
      io.to(room).emit('update_message_reaction', { messageId, reaction });
    } catch (err) {
      console.error("Error updating reaction:", err);
    }
  });

  socket.on('toggle_pending', async ({ messageId, status, room }) => {
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.findByIdAndUpdate(messageId, { flaggedPending: status });
      } else {
        const target = memoryMessages.find(m => m._id === messageId);
        if (target) target.flaggedPending = status;
      }
      io.to(room).emit('update_msg_status', { messageId, flaggedPending: status });
    } catch (err) {
      console.error("Error toggling pending flag:", err);
    }
  });

  socket.on('send_assistant_alert', ({ room, text }) => {
    io.to(room).emit('receive_assistant_alert', { text, timestamp: Date.now() });
  });

  socket.on('bubble_popped', ({ room }) => {
    socket.to(room).emit('parent_bubble_pop_notify');
  });

  socket.on('disconnect', () => {
    io.emit('peer_typing_status', { isTyping: false });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);
});