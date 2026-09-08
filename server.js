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

// Shared Synced Audio Rooms State
const roomSyncStates = new Map();

const getRoomSync = (room) => {
  if (!roomSyncStates.has(room)) {
    roomSyncStates.set(room, {
      connected: false,
      videoId: null,
      title: null,
      state: 'PAUSE',
      currentTime: 0,
      timestamp: Date.now()
    });
  }
  return roomSyncStates.get(room);
};

// Scheduled Alerts State
const scheduledAlerts = [];

app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat & Sync Background Audio Engine" });
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

// YouTube Video ID Resolver: Returns exact single videoId for ANY song query
app.get('/api/yt-search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ videoId: null });

  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await response.text();
    const match = text.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (match && match[1]) {
      const titleMatch = text.match(/"title":{"runs":\[{"text":"([^"]+)"/);
      return res.json({ 
        videoId: match[1], 
        title: titleMatch ? titleMatch[1] : query 
      });
    }
    res.json({ videoId: null, title: query });
  } catch (e) {
    res.json({ videoId: null, error: e.message });
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('join_room', async ({ room, role }) => {
    socket.join(room);
    socket.roomName = room;
    console.log(`Client ${socket.id} joined room "${room}" as role "${role}"`);

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

    // Re-sync current music state if already connected in this room
    const sync = getRoomSync(room);
    if (sync.connected && sync.videoId) {
      socket.emit('sync_connected_event', {
        videoId: sync.videoId,
        title: sync.title,
        state: sync.state
      });
    }

    // Send scheduled alert jobs to admin
    if (role === 'parent') {
      const sanitized = scheduledAlerts
        .filter(j => j.room === room)
        .map(({ id, text, timeStr }) => ({ id, text, timeStr }));
      socket.emit('scheduled_jobs_update', sanitized);
    }
  });

  // Real-time Typing Handlers
  socket.on('typing_start', (data) => {
    const room = (data && data.room) || socket.roomName || 'stealth_master_room';
    const role = (data && data.role) || '';
    socket.to(room).emit('peer_typing_status', { isTyping: true, senderRole: role });
  });

  socket.on('typing_stop', (data) => {
    const room = (data && data.room) || socket.roomName || 'stealth_master_room';
    const role = (data && data.role) || '';
    socket.to(room).emit('peer_typing_status', { isTyping: false, senderRole: role });
  });

  // Scheduled / Synced Handshake Sockets
  socket.on('sync_send_invite', ({ room, role }) => {
    socket.to(room).emit('sync_receive_invite', { fromRole: role });
  });

  socket.on('sync_confirm_invite', ({ room }) => {
    const sync = getRoomSync(room);
    sync.connected = true;
    io.to(room).emit('sync_connected_event', {
      videoId: sync.videoId,
      title: sync.title,
      state: sync.state
    });
  });

  socket.on('sync_disconnect_invite', ({ room }) => {
    const sync = getRoomSync(room);
    sync.connected = false;
    sync.videoId = null;
    sync.title = null;
    sync.state = 'PAUSE';
    io.to(room).emit('sync_disconnected_event');
  });

  // BIDIRECTIONAL TRACK SYNC: Saves track & broadcasts exact videoId to room
  socket.on('sync_track_change', ({ room, videoId, title }) => {
    const sync = getRoomSync(room);
    sync.videoId = videoId;
    sync.title = title;
    sync.state = 'PLAY';
    sync.currentTime = 0;
    sync.timestamp = Date.now();
    io.to(room).emit('sync_track_update', { videoId, title });
  });

  socket.on('sync_playback_state', ({ room, state, currentTime, timestamp }) => {
    const sync = getRoomSync(room);
    sync.state = state;
    sync.currentTime = currentTime;
    sync.timestamp = timestamp || Date.now();
    socket.to(room).emit('sync_playback_update', { state, currentTime, timestamp: sync.timestamp });
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
    
    socket.to(room).emit('peer_typing_status', { isTyping: false });

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
    socket.broadcast.emit('peer_typing_status', { isTyping: false });
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);
});