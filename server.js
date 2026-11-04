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

const loveBalanceSchema = new mongoose.Schema({
  key: { type: String, default: 'global_state', unique: true },
  loveBalance: { type: Number, default: 0 },
  adminLoveBalance: { type: Number, default: 0 },
  loveLedger: { type: Array, default: [] },
  wishRequests: { type: Array, default: [] }
}, { timestamps: true });

const LoveBalanceModel = mongoose.model('LoveBalance', loveBalanceSchema);

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB successfully.");
    try {
      const doc = await LoveBalanceModel.findOne({ key: 'global_state' });
      if (doc) {
        if (typeof doc.loveBalance === 'number') {
          globalLoveBalanceState.loveBalance = doc.loveBalance;
        }
        if (typeof doc.adminLoveBalance === 'number') {
          globalLoveBalanceState.adminLoveBalance = doc.adminLoveBalance;
        }
        if (Array.isArray(doc.loveLedger) && doc.loveLedger.length > 0) {
          const merged = [...doc.loveLedger];
          for (const item of (globalLoveBalanceState.loveLedger || [])) {
            if (!merged.some(m => m && m.id === item.id)) merged.push(item);
          }
          globalLoveBalanceState.loveLedger = merged;
        }
        if (Array.isArray(doc.wishRequests) && doc.wishRequests.length > 0) {
          const mergedWishes = [...doc.wishRequests];
          for (const r of (globalLoveBalanceState.wishRequests || [])) {
            if (!mergedWishes.some(w => w && w.id === r.id)) mergedWishes.push(r);
          }
          globalLoveBalanceState.wishRequests = mergedWishes;
        }
        persistLoveState();
        console.log("Synchronized Love Balance from MongoDB: Dora ₹", globalLoveBalanceState.loveBalance, "| Darsh ₹", globalLoveBalanceState.adminLoveBalance);
      }
    } catch (err) {
      console.warn("Error reading Love Balance from MongoDB:", err);
    }
    await seedDefaultSlotsIfEmpty();
  })
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

// --- DAILY PROJECTS & HOURLY ROUTINE TASK ENGINE ---
const dailyTaskSlotSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  timeRange: { type: String, required: true },
  tag: { type: String, default: 'Task' },
  rewardPoints: { type: Number, default: 1.0 },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const DailyTaskSlot = mongoose.model('DailyTaskSlot', dailyTaskSlotSchema);

const dailyTaskSubmissionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  date: { type: String, required: true }, // 'YYYY-MM-DD'
  slotId: { type: String, required: true },
  userRole: { type: String, default: 'user' },
  note: { type: String, default: '' },
  image: { type: String, default: '' },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  pointsAwarded: { type: Number, default: 0 },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  adminFeedback: { type: String, default: '' }
}, { timestamps: true });

const DailyTaskSubmission = mongoose.model('DailyTaskSubmission', dailyTaskSubmissionSchema);

const DEFAULT_DAILY_SLOTS = [
  { id: 'slot_1', title: 'Morning Workout (10 Squats / Stretch)', timeRange: '08:00 - 09:00', tag: 'Workout', rewardPoints: 2.0, order: 1, isActive: true },
  { id: 'slot_2', title: 'Healthy Detox Juice / Morning Drink', timeRange: '09:00 - 10:00', tag: 'Juice', rewardPoints: 1.5, order: 2, isActive: true },
  { id: 'slot_3', title: 'Heavy Breakfast (High-Calorie Meal Plate)', timeRange: '10:00 - 11:00', tag: 'Breakfast', rewardPoints: 2.5, order: 3, isActive: true },
  { id: 'slot_4', title: 'Lunch Check-in & Care Update', timeRange: '01:00 - 02:00', tag: 'Lunch', rewardPoints: 2.0, order: 4, isActive: true },
  { id: 'slot_5', title: 'Hydration Milestone (Water Intake)', timeRange: '03:30 - 04:30', tag: 'Water', rewardPoints: 1.0, order: 5, isActive: true },
  { id: 'slot_6', title: 'Evening Tea & Healthy Snack', timeRange: '05:00 - 05:30', tag: 'Tea', rewardPoints: 1.0, order: 6, isActive: true },
  { id: 'slot_7', title: 'High-Protein Dinner Plate', timeRange: '08:30 - 09:30', tag: 'Dinner', rewardPoints: 2.0, order: 7, isActive: true },
  { id: 'slot_8', title: 'Google Fit 8,000 Steps Screenshot', timeRange: '10:00 - 10:30', tag: 'Steps', rewardPoints: 3.0, order: 8, isActive: true },
  { id: 'slot_9', title: 'Night Skin Care Routine & Glow Check', timeRange: '10:30 - 11:00', tag: 'Skincare', rewardPoints: 2.0, order: 9, isActive: true }
];

let memoryDailySlots = [...DEFAULT_DAILY_SLOTS];
let memoryDailySubmissions = [];

async function seedDefaultSlotsIfEmpty() {
  try {
    if (mongoose.connection.readyState === 1) {
      const count = await DailyTaskSlot.countDocuments();
      if (count === 0) {
        await DailyTaskSlot.insertMany(DEFAULT_DAILY_SLOTS);
        console.log('Seeded default daily task slots into MongoDB.');
      }
    }
  } catch (err) {
    console.warn('Error seeding default daily slots:', err);
  }
}
seedDefaultSlotsIfEmpty();

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

// --- REAL-TIME SERVER-SIDE LOVE BALANCE & WISHES PERSISTENCE ---
const LOVE_STATE_FILE = path.join(__dirname, 'love_balance_state.json');

let globalLoveBalanceState = {
  loveBalance: 0,
  adminLoveBalance: 0,
  loveLedger: [],
  wishRequests: []
};

try {
  if (fs.existsSync(LOVE_STATE_FILE)) {
    const raw = fs.readFileSync(LOVE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      globalLoveBalanceState = {
        loveBalance: typeof parsed.loveBalance === 'number' ? parsed.loveBalance : 0,
        adminLoveBalance: typeof parsed.adminLoveBalance === 'number' ? parsed.adminLoveBalance : 0,
        loveLedger: Array.isArray(parsed.loveLedger) 
          ? parsed.loveLedger.filter(item => {
              if (!item) return false;
              if (item.id && /^lb_([1-9]|1[0-1])$/.test(item.id)) return false;
              if (item.description && (
                item.description.includes('Announcement Read') ||
                item.description.includes('Monthly Punctuality Reward')
              )) return false;
              return true;
            })
          : [],
        wishRequests: Array.isArray(parsed.wishRequests) ? parsed.wishRequests : []
      };
    }
  }
} catch (e) {
  console.warn('Could not read love_balance_state.json:', e);
}

function persistLoveState() {
  try {
    fs.writeFileSync(LOVE_STATE_FILE, JSON.stringify(globalLoveBalanceState, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not write love_balance_state.json:', e);
  }
  try {
    if (mongoose.connection.readyState === 1) {
      LoveBalanceModel.findOneAndUpdate(
        { key: 'global_state' },
        {
          loveBalance: globalLoveBalanceState.loveBalance,
          adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          loveLedger: globalLoveBalanceState.loveLedger,
          wishRequests: globalLoveBalanceState.wishRequests
        },
        { upsert: true, new: true }
      ).catch(err => console.warn('Could not save Love Balance to MongoDB:', err));
    }
  } catch (err) {
    console.warn('MongoDB save exception:', err);
  }
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

app.get('/', (req, res) => {
  res.send({ status: "Online", service: "Stealth Secret Chat & Arcade Engine v17" });
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

// --- REAL-TIME USER PRESENCE TRACKING ---
const activeRoomUsers = new Map(); // socket.id -> { room, role, isForeground: true, lastHeartbeat: timestamp }

function broadcastPresence(room) {
  const targetRoom = room || 'stealth_master_room';
  const onlineRoles = new Set();
  const now = Date.now();
  for (const [sId, info] of activeRoomUsers.entries()) {
    if (info.isForeground !== false && (now - (info.lastHeartbeat || now)) < 25000) {
      if (info.role) onlineRoles.add(info.role);
    }
  }
  const payload = {
    onlineRoles: Array.from(onlineRoles),
    timestamp: now
  };
  io.to(targetRoom).emit('presence_status', payload);
  io.emit('presence_status', payload);
}

// Clean up dead/stale connections every 8 seconds
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [sId, info] of activeRoomUsers.entries()) {
    if (now - (info.lastHeartbeat || now) > 25000) {
      activeRoomUsers.delete(sId);
      changed = true;
    }
  }
  if (changed) {
    broadcastPresence('stealth_master_room');
  }
}, 8000);

io.on('connection', (socket) => {
  socket.on('join_room', async ({ room, role }) => {
    socket.join(room);
    socket.roomName = room;
    socket.role = role || 'user';
    activeRoomUsers.set(socket.id, { 
      room, 
      role: socket.role, 
      isForeground: true, 
      lastHeartbeat: Date.now() 
    });
    broadcastPresence(room);

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

    // Sync Love Balance real-time state to newly connected client
    socket.emit('love_balance_broadcast', {
      action: 'SYNC_STATE_RESPONSE',
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      wishRequests: globalLoveBalanceState.wishRequests
    });

    try {
      const todayStr = new Date().toISOString().split('T')[0];
      let initialSlots = [];
      let initialSubmissions = [];
      if (mongoose.connection.readyState === 1) {
        initialSlots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        if (initialSlots.length === 0) {
          await DailyTaskSlot.insertMany(DEFAULT_DAILY_SLOTS);
          initialSlots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        }
        initialSubmissions = await DailyTaskSubmission.find({ date: todayStr }).lean();
      } else {
        initialSlots = memoryDailySlots;
        initialSubmissions = memoryDailySubmissions.filter(s => s.date === todayStr);
      }
      socket.emit('daily_task_sync_response', {
        date: todayStr,
        slots: initialSlots,
        submissions: initialSubmissions
      });
    } catch (e) {
      console.warn('Initial daily task sync error:', e);
    }
  });

  socket.on('typing_start', (data) => {
    const role = (data && data.role) || '';
    socket.broadcast.emit('peer_typing_status', { isTyping: true, senderRole: role });
  });

  socket.on('typing_stop', (data) => {
    const role = (data && data.role) || '';
    socket.broadcast.emit('peer_typing_status', { isTyping: false, senderRole: role });
  });

  // --- WEBRTC AUDIO CALL & SIGNALING RELAYS ---
  socket.on('start_audio_call', (data) => {
    socket.broadcast.emit('start_audio_call', data || {});
  });

  socket.on('accept_audio_call', (data) => {
    socket.broadcast.emit('accept_audio_call', data || {});
  });

  socket.on('end_audio_call', (data) => {
    socket.broadcast.emit('end_audio_call', data || {});
  });

  socket.on('webrtc_offer', (data) => {
    socket.broadcast.emit('webrtc_offer', data || {});
  });

  socket.on('webrtc_answer', (data) => {
    socket.broadcast.emit('webrtc_answer', data || {});
  });

  socket.on('webrtc_ice_candidate', (data) => {
    socket.broadcast.emit('webrtc_ice_candidate', data || {});
  });

  // --- CODEX TOGEPI LIVE MOVIE CHAT SYNC ---
  socket.on('togepi_movie_chat', (data) => {
    io.emit('togepi_movie_chat', data || {});
  });

  // --- CODEX DELAY GAP REALIGN SYNC ---
  socket.on('codex_force_realign', (data) => {
    if (data) {
      codexCinemaState.state = data.state || codexCinemaState.state;
      codexCinemaState.currentTime = data.currentTime !== undefined ? data.currentTime : codexCinemaState.currentTime;
      codexCinemaState.lastUpdated = data.timestamp || Date.now();
    }
    socket.broadcast.emit('codex_force_realign_broadcast', data || {});
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

  // --- REAL-TIME LOVE BALANCE & WISHES SYNC ---
  socket.on('love_balance_action', (data) => {
    if (!data) return;

    if (data.action === 'CLEAR_LEDGER') {
      const target = data.target || 'user';
      if (target === 'user') {
        globalLoveBalanceState.loveBalance = 0;
        globalLoveBalanceState.loveLedger = globalLoveBalanceState.loveLedger.filter(item => item.target === 'admin' || (item.description && item.description.includes('[Darsh]')));
      } else if (target === 'admin') {
        globalLoveBalanceState.adminLoveBalance = 0;
        globalLoveBalanceState.loveLedger = globalLoveBalanceState.loveLedger.filter(item => item.target !== 'admin' && !(item.description && item.description.includes('[Darsh]')));
      } else {
        globalLoveBalanceState.loveBalance = 0;
        globalLoveBalanceState.adminLoveBalance = 0;
        globalLoveBalanceState.loveLedger = [];
      }
      persistLoveState();
    } else if (data.action === 'TRANSACTION') {
      const numAmount = Math.abs(parseFloat(data.amount) || 0);
      const delta = data.type === 'credit' ? numAmount : -numAmount;
      if (data.target === 'admin') {
        globalLoveBalanceState.adminLoveBalance = parseFloat((globalLoveBalanceState.adminLoveBalance + delta).toFixed(2));
      } else {
        globalLoveBalanceState.loveBalance = parseFloat((globalLoveBalanceState.loveBalance + delta).toFixed(2));
      }
      if (data.newEntry) {
        globalLoveBalanceState.loveLedger = [data.newEntry, ...globalLoveBalanceState.loveLedger.filter(e => e.id !== data.newEntry.id)];
      }
      persistLoveState();
    } else if (data.action === 'OVERRIDE_BALANCE') {
      const val = parseFloat(data.newBalance) || 0;
      if (data.target === 'admin') {
        globalLoveBalanceState.adminLoveBalance = val;
      } else {
        globalLoveBalanceState.loveBalance = val;
      }
      persistLoveState();
    } else if (data.action === 'REQUEST_SYNC') {
      socket.emit('love_balance_broadcast', {
        action: 'SYNC_STATE_RESPONSE',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests
      });
      return;
    } else if (data.action === 'DAILY_TASK_SUBMIT' && data.submission) {
      const sub = data.submission;
      if (mongoose.connection.readyState === 1) {
        DailyTaskSubmission.findOneAndUpdate(
          { id: sub.id },
          sub,
          { upsert: true, new: true }
        ).catch(err => console.error('Error saving DAILY_TASK_SUBMIT in Mongo:', err));
      } else {
        const idx = memoryDailySubmissions.findIndex(s => s.id === sub.id);
        if (idx >= 0) memoryDailySubmissions[idx] = sub;
        else memoryDailySubmissions.push(sub);
      }
    } else if (data.action === 'DAILY_TASK_APPROVED' && data.submissionId) {
      const pts = parseFloat(data.points) || 0;
      if (mongoose.connection.readyState === 1) {
        DailyTaskSubmission.findOneAndUpdate(
          { id: data.submissionId },
          { status: 'APPROVED', pointsAwarded: pts, reviewedAt: new Date() },
          { new: true }
        ).catch(err => console.error('Error approving DAILY_TASK in Mongo:', err));
      } else {
        const item = memoryDailySubmissions.find(s => s.id === data.submissionId);
        if (item) {
          item.status = 'APPROVED';
          item.pointsAwarded = pts;
          item.reviewedAt = new Date();
        }
      }
    } else if (data.action === 'DAILY_TASK_REJECTED' && data.submissionId) {
      if (mongoose.connection.readyState === 1) {
        DailyTaskSubmission.findOneAndUpdate(
          { id: data.submissionId },
          { status: 'REJECTED', adminFeedback: data.feedback || '', reviewedAt: new Date() },
          { new: true }
        ).catch(err => console.error('Error rejecting DAILY_TASK in Mongo:', err));
      } else {
        const item = memoryDailySubmissions.find(s => s.id === data.submissionId);
        if (item) {
          item.status = 'REJECTED';
          item.adminFeedback = data.feedback || '';
          item.reviewedAt = new Date();
        }
      }
    } else if (data.action === 'WISH_REQUEST' && data.wishRequest) {
      globalLoveBalanceState.wishRequests = [data.wishRequest, ...globalLoveBalanceState.wishRequests.filter(r => r.id !== data.wishRequest.id)];
      persistLoveState();
    } else if (data.action === 'WISH_APPROVED' && data.wishRequest) {
      globalLoveBalanceState.wishRequests = globalLoveBalanceState.wishRequests.map(r => r.id === data.wishRequest.id ? { ...r, status: 'APPROVED' } : r);
      persistLoveState();
    } else if (data.action === 'WISH_DECLINED' && data.wishRequest) {
      globalLoveBalanceState.wishRequests = globalLoveBalanceState.wishRequests.map(r => r.id === data.wishRequest.id ? { ...r, status: 'DECLINED' } : r);
      persistLoveState();
    } else if (data.action === 'TOGGLE_FULFILLMENT') {
      globalLoveBalanceState.loveLedger = globalLoveBalanceState.loveLedger.map(item => {
        if (item.id === data.wishId) {
          const nextStatus = item.fulfillmentStatus === 'Fulfilled' ? 'Pending' : 'Fulfilled';
          return { ...item, fulfillmentStatus: nextStatus };
        }
        return item;
      });
      persistLoveState();
    }

    const payload = {
      ...data,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      serverTimestamp: Date.now()
    };
    io.emit('love_balance_broadcast', payload);
  });

  // --- DAILY PROJECTS & HOURLY ROUTINE SOCKET ENGINE ---
  socket.on('daily_task_request_sync', async ({ date }) => {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      let slots = [];
      let submissions = [];

      if (mongoose.connection.readyState === 1) {
        slots = await DailyTaskSlot.find().sort({ order: 1, createdAt: 1 }).lean();
        if (slots.length === 0) {
          await DailyTaskSlot.insertMany(DEFAULT_DAILY_SLOTS);
          slots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        }
        submissions = await DailyTaskSubmission.find({ date: targetDate }).lean();
      } else {
        slots = memoryDailySlots;
        submissions = memoryDailySubmissions.filter(s => s.date === targetDate);
      }

      socket.emit('daily_task_sync_response', {
        date: targetDate,
        slots,
        submissions
      });
    } catch (err) {
      console.error('Error in daily_task_request_sync:', err);
    }
  });

  socket.on('daily_task_submit', async (data) => {
    try {
      const { date, slotId, note, image, userRole, slotTitle } = data || {};
      if (userRole === 'parent') return; // Tasks are strictly for Dora to submit; Darsh only reviews & approves
      if (!slotId) return;
      const targetDate = date || new Date().toISOString().split('T')[0];
      const submissionId = 'sub_' + targetDate + '_' + slotId;

      const submissionData = {
        id: submissionId,
        date: targetDate,
        slotId,
        userRole: userRole || 'user',
        note: note || '',
        image: image || '',
        status: 'PENDING',
        pointsAwarded: 0,
        submittedAt: new Date(),
        reviewedAt: null,
        adminFeedback: ''
      };

      if (mongoose.connection.readyState === 1) {
        await DailyTaskSubmission.findOneAndUpdate(
          { id: submissionId },
          submissionData,
          { upsert: true, new: true }
        );
      } else {
        const idx = memoryDailySubmissions.findIndex(s => s.id === submissionId);
        if (idx >= 0) {
          memoryDailySubmissions[idx] = submissionData;
        } else {
          memoryDailySubmissions.push(submissionData);
        }
      }

      // Broadcast updated submission so both Dora and Darsh see it immediately
      io.emit('daily_task_submission_updated', {
        submission: submissionData,
        isNew: true
      });

      // Send real-time notification alert to Admin (Darsh)
      io.emit('daily_task_admin_alert', {
        slotId,
        slotTitle: slotTitle || 'Routine Task',
        date: targetDate,
        note: note || '',
        hasImage: Boolean(image),
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('Error in daily_task_submit:', err);
    }
  });

  socket.on('daily_task_approve', async ({ submissionId, points, feedback, slotTitle }) => {
    try {
      if (!submissionId) return;
      const pts = parseFloat(points) || 0;
      let updatedSubmission = null;

      if (mongoose.connection.readyState === 1) {
        updatedSubmission = await DailyTaskSubmission.findOneAndUpdate(
          { id: submissionId },
          {
            status: 'APPROVED',
            pointsAwarded: pts,
            reviewedAt: new Date(),
            adminFeedback: feedback || ''
          },
          { new: true }
        ).lean();
      } else {
        const sub = memoryDailySubmissions.find(s => s.id === submissionId);
        if (sub) {
          sub.status = 'APPROVED';
          sub.pointsAwarded = pts;
          sub.reviewedAt = new Date();
          sub.adminFeedback = feedback || '';
          updatedSubmission = sub;
        }
      }

      // Award Love Balance points to Dora
      if (pts > 0) {
        globalLoveBalanceState.loveBalance = parseFloat((globalLoveBalanceState.loveBalance + pts).toFixed(2));
        const newEntry = {
          id: 'lb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          sl: 1,
          target: 'user',
          description: '[Dora] Approved Task: ' + (slotTitle || 'Daily Routine Task'),
          earnedAt: new Date().toLocaleString('en-GB'),
          expireDate: '',
          points: pts,
          type: 'credit',
          remarks: 'Daily Routine Task Approved by Darsh',
          status: 'Confirmed'
        };
        globalLoveBalanceState.loveLedger = [newEntry, ...(globalLoveBalanceState.loveLedger || [])];
        persistLoveState();

        io.emit('love_balance_broadcast', {
          action: 'TRANSACTION',
          target: 'user',
          amount: pts,
          type: 'credit',
          reason: 'Daily Task Approved: ' + (slotTitle || 'Task'),
          newEntry,
          currentLoveBalance: globalLoveBalanceState.loveBalance,
          currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          serverTimestamp: Date.now()
        });
      }

      io.emit('daily_task_submission_updated', {
        submission: updatedSubmission,
        approved: true,
        pointsAwarded: pts,
        slotTitle: slotTitle || 'Routine Task'
      });
    } catch (err) {
      console.error('Error in daily_task_approve:', err);
    }
  });

  socket.on('daily_task_reject', async ({ submissionId, feedback }) => {
    try {
      if (!submissionId) return;
      let updatedSubmission = null;

      if (mongoose.connection.readyState === 1) {
        updatedSubmission = await DailyTaskSubmission.findOneAndUpdate(
          { id: submissionId },
          {
            status: 'REJECTED',
            reviewedAt: new Date(),
            adminFeedback: feedback || 'Please retake with clear proof'
          },
          { new: true }
        ).lean();
      } else {
        const sub = memoryDailySubmissions.find(s => s.id === submissionId);
        if (sub) {
          sub.status = 'REJECTED';
          sub.reviewedAt = new Date();
          sub.adminFeedback = feedback || 'Please retake with clear proof';
          updatedSubmission = sub;
        }
      }

      io.emit('daily_task_submission_updated', {
        submission: updatedSubmission,
        rejected: true
      });
    } catch (err) {
      console.error('Error in daily_task_reject:', err);
    }
  });

  socket.on('daily_slot_create', async (slotData) => {
    try {
      const newSlot = {
        id: 'slot_' + Date.now(),
        title: slotData.title || 'New Routine Task',
        timeRange: slotData.timeRange || '09:00 - 10:00',
        tag: slotData.tag || 'Task',
        rewardPoints: parseFloat(slotData.rewardPoints) || 1.0,
        order: parseInt(slotData.order) || 99,
        isActive: true
      };

      if (mongoose.connection.readyState === 1) {
        await DailyTaskSlot.create(newSlot);
        const allSlots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        io.emit('daily_slots_updated', { slots: allSlots });
      } else {
        memoryDailySlots.push(newSlot);
        io.emit('daily_slots_updated', { slots: memoryDailySlots });
      }
    } catch (err) {
      console.error('Error in daily_slot_create:', err);
    }
  });

  socket.on('daily_slot_update', async ({ slotId, updates }) => {
    try {
      if (!slotId) return;
      if (mongoose.connection.readyState === 1) {
        await DailyTaskSlot.findOneAndUpdate({ id: slotId }, updates, { new: true });
        const allSlots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        io.emit('daily_slots_updated', { slots: allSlots });
      } else {
        const idx = memoryDailySlots.findIndex(s => s.id === slotId);
        if (idx >= 0) {
          memoryDailySlots[idx] = { ...memoryDailySlots[idx], ...updates };
        }
        io.emit('daily_slots_updated', { slots: memoryDailySlots });
      }
    } catch (err) {
      console.error('Error in daily_slot_update:', err);
    }
  });

  socket.on('daily_slot_delete', async ({ slotId }) => {
    try {
      if (!slotId) return;
      if (mongoose.connection.readyState === 1) {
        await DailyTaskSlot.deleteOne({ id: slotId });
        const allSlots = await DailyTaskSlot.find().sort({ order: 1 }).lean();
        io.emit('daily_slots_updated', { slots: allSlots });
      } else {
        memoryDailySlots = memoryDailySlots.filter(s => s.id !== slotId);
        io.emit('daily_slots_updated', { slots: memoryDailySlots });
      }
    } catch (err) {
      console.error('Error in daily_slot_delete:', err);
    }
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

  socket.on('presence_visibility', ({ room, role, isForeground }) => {
    const targetRoom = room || socket.roomName || 'stealth_master_room';
    if (activeRoomUsers.has(socket.id)) {
      const entry = activeRoomUsers.get(socket.id);
      entry.isForeground = isForeground !== false;
      entry.lastHeartbeat = Date.now();
    } else {
      activeRoomUsers.set(socket.id, { 
        room: targetRoom, 
        role: role || socket.role || 'user', 
        isForeground: isForeground !== false,
        lastHeartbeat: Date.now() 
      });
    }
    broadcastPresence(targetRoom);
  });

  socket.on('presence_ping', ({ room, role, isForeground }) => {
    const targetRoom = room || socket.roomName || 'stealth_master_room';
    socket.role = role || socket.role || 'user';
    socket.roomName = targetRoom;
    activeRoomUsers.set(socket.id, {
      room: targetRoom,
      role: socket.role,
      isForeground: isForeground !== false,
      lastHeartbeat: Date.now()
    });
    broadcastPresence(targetRoom);
  });

  socket.on('disconnect', () => {
    activeRoomUsers.delete(socket.id);
    if (socket.roomName) {
      broadcastPresence(socket.roomName);
    }
    io.emit('peer_typing_status', { isTyping: false });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);
});