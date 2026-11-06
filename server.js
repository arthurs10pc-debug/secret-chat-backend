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

// --- REAL-TIME SERVER-SIDE LOVE BALANCE & WISHES PERSISTENCE ---
const LOVE_STATE_FILE = path.join(__dirname, 'love_balance_state.json');

let globalLoveBalanceState = {
  loveBalance: 0,
  adminLoveBalance: 0,
  loveLedger: [],
  wishRequests: [],
  deletedSlotIds: [],
  dailySlots: []
};

function calculateNetBalance(ledger, target = 'user') {
  if (!Array.isArray(ledger)) return 0;
  const entries = ledger.filter(e => {
    if (!e) return false;
    if (target === 'admin') {
      return e.target === 'admin' || (e.description && e.description.includes('[Darsh]'));
    }
    return e.target !== 'admin' && !(e.description && e.description.includes('[Darsh]'));
  });

  const credits = entries
    .filter(e => e.type === 'credit')
    .reduce((sum, e) => sum + Math.abs(Number(e.points) || 0), 0);

  const debits = entries
    .filter(e => e.type === 'debit' && e.status !== 'Redeemed')
    .reduce((sum, e) => sum + Math.abs(Number(e.points) || 0), 0);

  const redeems = entries
    .filter(e => e.type === 'redeem' || e.status === 'Redeemed')
    .reduce((sum, e) => sum + Math.abs(Number(e.points) || 0), 0);

  return parseFloat((credits - debits - redeems).toFixed(2));
}

function syncBalancesFromLedger() {
  globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
  globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
}

function sanitizeLedger(ledger) {
  if (!Array.isArray(ledger)) return [];
  const istOffset = 5.5 * 60 * 60 * 1000;
  const lastCleared = globalLoveBalanceState?.lastClearedAt || 0;
  const todayStr = new Date(Date.now() + istOffset).toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() + istOffset - 86400000).toISOString().split('T')[0];
  const clearedToday = lastCleared > 0 && new Date(lastCleared + istOffset).toISOString().split('T')[0] === todayStr;

  return ledger.filter(item => {
    if (!item) return false;
    if (item.id && /^lb_([1-9]|1[0-1])$/.test(item.id)) return false;
    if (item.description && (
      item.description.includes('Announcement Read') ||
      item.description.includes('Monthly Punctuality Reward')
    )) return false;

    // If cleared today, purge all auto-generated habit infractions for today & yesterday that occurred around clear
    if (clearedToday && item.description) {
      const isHabitDeduction = item.type === 'debit' && (
        item.description.includes('Missed Morning Greeting') ||
        item.description.includes('Sleeping Without "Good Night"') ||
        item.description.includes('Missed Routine Task')
      );
      if (isHabitDeduction && (item.description.includes(todayStr) || item.description.includes(yesterdayStr) || item.description.includes('(Today)'))) {
        return false;
      }
    }

    return true;
  });
}

try {
  if (fs.existsSync(LOVE_STATE_FILE)) {
    const raw = fs.readFileSync(LOVE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      globalLoveBalanceState = {
        loveBalance: typeof parsed.loveBalance === 'number' ? parsed.loveBalance : 0,
        adminLoveBalance: typeof parsed.adminLoveBalance === 'number' ? parsed.adminLoveBalance : 0,
        loveLedger: sanitizeLedger(parsed.loveLedger),
        wishRequests: Array.isArray(parsed.wishRequests) ? parsed.wishRequests : [],
        deletedSlotIds: Array.isArray(parsed.deletedSlotIds) ? parsed.deletedSlotIds : [],
        dailySlots: Array.isArray(parsed.dailySlots) ? parsed.dailySlots : []
      };
      syncBalancesFromLedger();
    }
  }
} catch (e) {
  console.warn('Could not read love_balance_state.json:', e);
}

const loveBalanceSchema = new mongoose.Schema({
  key: { type: String, default: 'global_state', unique: true },
  loveBalance: { type: Number, default: 0 },
  adminLoveBalance: { type: Number, default: 0 },
  loveLedger: { type: Array, default: [] },
  wishRequests: { type: Array, default: [] },
  deletedSlotIds: { type: Array, default: [] },
  deletedTransactionIds: { type: Array, default: [] },
  lastClearedAt: { type: Number, default: 0 },
  dailySlots: { type: Array, default: [] }
}, { timestamps: true });

const LoveBalanceModel = mongoose.model('LoveBalance', loveBalanceSchema);

function persistLoveState() {
  const deletedTxs = globalLoveBalanceState.deletedTransactionIds || [];
  globalLoveBalanceState.loveLedger = sanitizeLedger(globalLoveBalanceState.loveLedger).filter(item => item && !deletedTxs.includes(item.id));
  syncBalancesFromLedger();
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
          wishRequests: globalLoveBalanceState.wishRequests,
          deletedSlotIds: globalLoveBalanceState.deletedSlotIds,
          deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds,
          lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
          dailySlots: globalLoveBalanceState.dailySlots
        },
        { upsert: true, new: true }
      ).catch(err => console.warn('Could not save Love Balance to MongoDB:', err));
    }
  } catch (err) {
    console.warn('MongoDB save exception:', err);
  }
}

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB successfully.");
    try {
      const doc = await LoveBalanceModel.findOne({ key: 'global_state' });
      if (doc) {
        if (Array.isArray(doc.deletedSlotIds) && doc.deletedSlotIds.length > 0) {
          const mergedDeleted = Array.from(new Set([...(globalLoveBalanceState.deletedSlotIds || []), ...doc.deletedSlotIds]));
          globalLoveBalanceState.deletedSlotIds = mergedDeleted;
        }
        if (Array.isArray(doc.deletedTransactionIds)) {
          globalLoveBalanceState.deletedTransactionIds = Array.from(new Set([...(globalLoveBalanceState.deletedTransactionIds || []), ...doc.deletedTransactionIds]));
        }
        if (typeof doc.lastClearedAt === 'number') {
          globalLoveBalanceState.lastClearedAt = doc.lastClearedAt;
        }
        if (Array.isArray(doc.loveLedger)) {
          const activeDelTxs = globalLoveBalanceState.deletedTransactionIds || [];
          globalLoveBalanceState.loveLedger = sanitizeLedger(doc.loveLedger).filter(item => item && !activeDelTxs.includes(item.id));
        }
        if (Array.isArray(doc.wishRequests) && doc.wishRequests.length > 0) {
          const mergedWishes = [...doc.wishRequests];
          for (const r of (globalLoveBalanceState.wishRequests || [])) {
            if (!mergedWishes.some(w => w && w.id === r.id)) mergedWishes.push(r);
          }
          globalLoveBalanceState.wishRequests = mergedWishes;
        }
        if (Array.isArray(doc.dailySlots) && doc.dailySlots.length > 0) {
          globalLoveBalanceState.dailySlots = doc.dailySlots.filter(s => s && !(globalLoveBalanceState.deletedSlotIds || []).includes(s.id));
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
    const deleted = globalLoveBalanceState.deletedSlotIds || [];
    const validDefaults = DEFAULT_DAILY_SLOTS.filter(s => !deleted.includes(s.id));

    if (mongoose.connection.readyState === 1) {
      const count = await DailyTaskSlot.countDocuments();
      if (count === 0 && validDefaults.length > 0) {
        await DailyTaskSlot.insertMany(validDefaults);
        console.log('Seeded default daily task slots into MongoDB.');
      }
      if (deleted.length > 0) {
        await DailyTaskSlot.deleteMany({ id: { $in: deleted } }).catch(() => {});
      }
    }
    if (Array.isArray(globalLoveBalanceState.dailySlots) && globalLoveBalanceState.dailySlots.length > 0) {
      memoryDailySlots = globalLoveBalanceState.dailySlots.filter(s => s && !deleted.includes(s.id));
    } else {
      memoryDailySlots = validDefaults;
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

function evaluateRoutineAndHabitInfractions() {
  try {
    const now = new Date();
    // Indian Standard Time (UTC+5:30)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayStr = istNow.toISOString().split('T')[0];
    const yesterdayIst = new Date(istNow.getTime() - 86400000);
    const yesterdayStr = yesterdayIst.toISOString().split('T')[0];
    const currentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const currentHour = istNow.getUTCHours();

    const parseSlotEndMinutes = (timeRange) => {
      if (!timeRange || typeof timeRange !== 'string') return null;
      const parts = timeRange.split('-').map(p => p.trim());
      if (parts.length < 2) return null;
      const timePart = parts[1];
      const colonIdx = timePart.indexOf(':');
      if (colonIdx === -1) return null;
      let h = parseInt(timePart.slice(0, colonIdx), 10);
      let m = parseInt(timePart.slice(colonIdx + 1, colonIdx + 3) || '0', 10);
      if (isNaN(h)) return null;
      if (h >= 1 && h <= 7) h += 12; // 01:00 PM to 07:00 PM
      return h * 60 + m;
    };

    const hasLedgerMatch = (keyword) => {
      return (globalLoveBalanceState.loveLedger || []).some(e => e && e.description && e.description.includes(keyword));
    };

    const activeSlots = (memoryDailySlots || []).filter(s => s && s.isActive && !(globalLoveBalanceState.deletedSlotIds || []).includes(s.id));
    let ledgerChanged = false;

    // 1. TODAY'S ROUTINE TASKS DEADLINE EVALUATION
    const lastCleared = globalLoveBalanceState.lastClearedAt || 0;
    if (lastCleared > 0) {
      const clearedDate = new Date(lastCleared + istOffset).toISOString().split('T')[0];
      if (clearedDate >= todayStr) {
        // Cleared today! Forgive all routine penalties for today; only resume next day!
        return;
      }
    }

    activeSlots.forEach(slot => {
      const endMinutes = parseSlotEndMinutes(slot.timeRange);
      if (endMinutes !== null && currentMinutes >= endMinutes) {
        const sub = memoryDailySubmissions.find(s => s && s.slotId === slot.id && s.date === todayStr);
        const hasValidSubmission = sub && (sub.status === 'APPROVED' || sub.status === 'PENDING') && Boolean(sub.image || sub.note);
        const missedKey = `[Dora] Missed Routine Task: ${slot.title} (${todayStr})`;
        const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
        const wasDeleted = delTxs.some(id => id.includes(`missed_${todayStr}_${slot.id}`));
        if (!hasValidSubmission && !hasLedgerMatch(missedKey) && !wasDeleted) {
          const cutPts = Number(slot.rewardPoints || 2.0);
          const newEntry = {
            id: `missed_${todayStr}_${slot.id}`,
            sl: 1,
            target: 'user',
            description: missedKey,
            earnedAt: new Date().toLocaleString('en-GB'),
            expireDate: '',
            points: -cutPts,
            type: 'debit',
            remarks: 'Routine Task Deadline Expired Without Proof',
            status: 'Deducted'
          };
          globalLoveBalanceState.loveLedger = [newEntry, ...(globalLoveBalanceState.loveLedger || [])];
          ledgerChanged = true;
        }
      }
    });

    // 2. MORNING GREETING & MESSAGE HABITS:
    // Handled authoritatively by clients who possess the decryption key for end-to-end encrypted messages.

    if (ledgerChanged) {
      persistLoveState();
      io.emit('love_balance_broadcast', {
        action: 'SYNC_STATE_RESPONSE',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests,
        dailySubmissions: memoryDailySubmissions,
        dailySlots: activeSlots,
        deletedSlotIds: globalLoveBalanceState.deletedSlotIds || []
      });
    }
  } catch (err) {
    console.error('Error in evaluateRoutineAndHabitInfractions:', err);
  }
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

// Periodically evaluate routine slot deadlines and morning habit infractions every 60s
setInterval(evaluateRoutineAndHabitInfractions, 60000);
setTimeout(evaluateRoutineAndHabitInfractions, 3000);

// High-frequency 4-second authoritative sync heartbeat broadcast across all devices
setInterval(() => {
  const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
  io.emit('love_balance_heartbeat_sync', {
    loveBalance: globalLoveBalanceState.loveBalance,
    adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    currentLoveBalance: globalLoveBalanceState.loveBalance,
    currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    loveLedger: globalLoveBalanceState.loveLedger,
    wishRequests: globalLoveBalanceState.wishRequests,
    dailySubmissions: memoryDailySubmissions,
    dailySlots: (memoryDailySlots || []).filter(s => s && !activeDeleted.includes(s.id)),
    deletedSlotIds: activeDeleted,
    deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
    lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
    serverTimestamp: Date.now()
  });
}, 4000);

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
    const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
    const activeSlots = (memoryDailySlots || []).filter(s => s && !activeDeleted.includes(s.id));
    socket.emit('love_balance_broadcast', {
      action: 'SYNC_STATE_RESPONSE',
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      wishRequests: globalLoveBalanceState.wishRequests,
      deletedSlotIds: activeDeleted,
      dailySlots: activeSlots
    });

    try {
      const todayStr = new Date().toISOString().split('T')[0];
      let initialSlots = [];
      let initialSubmissions = [];
      if (mongoose.connection.readyState === 1) {
        initialSlots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).sort({ order: 1 }).lean();
        if (initialSlots.length === 0) {
          const validDefaults = DEFAULT_DAILY_SLOTS.filter(s => !activeDeleted.includes(s.id));
          if (validDefaults.length > 0) {
            await DailyTaskSlot.insertMany(validDefaults);
            initialSlots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).sort({ order: 1 }).lean();
          }
        }
        initialSubmissions = await DailyTaskSubmission.find({ date: todayStr }).lean();
      } else {
        initialSlots = activeSlots;
        initialSubmissions = memoryDailySubmissions.filter(s => s.date === todayStr);
      }
      socket.emit('daily_task_sync_response', {
        date: todayStr,
        slots: initialSlots,
        submissions: initialSubmissions,
        deletedSlotIds: activeDeleted
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
        globalLoveBalanceState.loveLedger = globalLoveBalanceState.loveLedger.filter(item => item.target === 'admin' || (item.description && item.description.includes('[Darsh]')));
      } else if (target === 'admin') {
        globalLoveBalanceState.loveLedger = globalLoveBalanceState.loveLedger.filter(item => item.target !== 'admin' && !(item.description && item.description.includes('[Darsh]')));
      } else {
        globalLoveBalanceState.loveLedger = [];
      }
      globalLoveBalanceState.lastClearedAt = Date.now();
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
    } else if (data.action === 'DELETE_TRANSACTION' && data.transactionId) {
      if (!Array.isArray(globalLoveBalanceState.deletedTransactionIds)) {
        globalLoveBalanceState.deletedTransactionIds = [];
      }
      globalLoveBalanceState.deletedTransactionIds.push(data.transactionId);
      globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(e => e && e.id !== data.transactionId);
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
    } else if (data.action === 'TRANSACTION') {
      if (data.newEntry) {
        const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
        if (!delTxs.includes(data.newEntry.id)) {
          globalLoveBalanceState.loveLedger = [data.newEntry, ...globalLoveBalanceState.loveLedger.filter(e => e.id !== data.newEntry.id)];
        }
      }
      persistLoveState();
    } else if (data.action === 'OVERRIDE_BALANCE') {
      const val = parseFloat(data.newBalance) || 0;
      const target = data.target || 'user';
      const curr = calculateNetBalance(globalLoveBalanceState.loveLedger, target);
      const diff = parseFloat((val - curr).toFixed(2));
      if (diff !== 0) {
        const type = diff > 0 ? 'credit' : 'debit';
        const numAmount = Math.abs(diff);
        const targetLabel = target === 'user' ? 'Dora' : 'Darsh';
        const newEntry = {
          id: 'lb_adj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          sl: 1,
          target,
          description: '[' + targetLabel + '] Admin Balance Adjustment (' + (diff > 0 ? '+' : '') + diff.toFixed(2) + ')',
          earnedAt: new Date().toLocaleString('en-GB'),
          expireDate: '',
          points: type === 'credit' ? numAmount : -numAmount,
          type,
          remarks: 'Manual Balance Set by Admin',
          status: 'Confirmed'
        };
        globalLoveBalanceState.loveLedger = [newEntry, ...globalLoveBalanceState.loveLedger];
      }
      persistLoveState();
    } else if (data.action === 'REQUEST_SYNC') {
      if (Array.isArray(data.deletedSlotIds) && data.deletedSlotIds.length > 0) {
        globalLoveBalanceState.deletedSlotIds = Array.from(new Set([
          ...(globalLoveBalanceState.deletedSlotIds || []),
          ...data.deletedSlotIds
        ]));
      }
      const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
      // Server is the authoritative single source of truth for loveLedger.
      // Do not merge stale client historical ledgers into the master server ledger.
      if (Array.isArray(data.clientWishRequests) && data.clientWishRequests.length > 0) {
        const mergedW = [...(globalLoveBalanceState.wishRequests || [])];
        for (const w of data.clientWishRequests) {
          if (w && w.id && !mergedW.some(m => m && m.id === w.id)) mergedW.push(w);
        }
        globalLoveBalanceState.wishRequests = mergedW;
      }
      if (Array.isArray(data.clientSubmissions) && data.clientSubmissions.length > 0) {
        for (const sub of data.clientSubmissions) {
          if (sub && sub.id) {
            const idx = memoryDailySubmissions.findIndex(s => s.id === sub.id);
            if (idx >= 0) memoryDailySubmissions[idx] = sub;
            else memoryDailySubmissions.push(sub);
          }
        }
      }
      if (Array.isArray(data.clientSlots) && data.clientSlots.length > 0) {
        memoryDailySlots = data.clientSlots.filter(s => s && s.id && !activeDeleted.includes(s.id));
        globalLoveBalanceState.dailySlots = memoryDailySlots;
      }
      persistLoveState();

      socket.emit('love_balance_broadcast', {
        action: 'SYNC_STATE_RESPONSE',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests,
        dailySubmissions: memoryDailySubmissions,
        dailySlots: (memoryDailySlots || []).filter(s => s && !activeDeleted.includes(s.id)),
        deletedSlotIds: activeDeleted,
        deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
        lastClearedAt: globalLoveBalanceState.lastClearedAt || 0
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
      }
      const idx = memoryDailySubmissions.findIndex(s => s.id === sub.id);
      if (idx >= 0) memoryDailySubmissions[idx] = sub;
      else memoryDailySubmissions.push(sub);
      
      // Also broadcast daily_task_submission_updated and admin alert
      io.emit('daily_task_submission_updated', { submission: sub, isNew: true });
      io.emit('daily_task_admin_alert', {
        slotId: sub.slotId,
        slotTitle: sub.slotTitle || 'Routine Task',
        date: sub.date,
        note: sub.note || '',
        hasImage: Boolean(sub.image),
        timestamp: Date.now()
      });
    } else if (data.action === 'DAILY_TASK_APPROVED' && (data.submissionId || data.slotId)) {
      const pts = parseFloat(data.points) || 0;
      let dbSub = null;
      if (mongoose.connection.readyState === 1) {
        const query = data.submissionId ? { id: data.submissionId } : { slotId: data.slotId, date: data.date };
        DailyTaskSubmission.findOneAndUpdate(
          query,
          { status: 'APPROVED', pointsAwarded: pts, reviewedAt: new Date(), adminFeedback: 'Approved by Darsh' },
          { new: true }
        ).then(doc => { if (doc) dbSub = doc.toObject(); }).catch(err => console.error('Error approving DAILY_TASK in Mongo:', err));
      }
      let item = memoryDailySubmissions.find(s => (data.submissionId && s.id === data.submissionId) || (data.slotId && s.slotId === data.slotId && (!data.date || s.date === data.date)));
      if (item) {
        item.status = 'APPROVED';
        item.pointsAwarded = pts;
        item.reviewedAt = new Date();
        item.adminFeedback = 'Approved by Darsh';
      } else {
        item = {
          id: data.submissionId || `sub_${data.date || new Date().toISOString().split('T')[0]}_${data.slotId}`,
          slotId: data.slotId || '',
          date: data.date || new Date().toISOString().split('T')[0],
          status: 'APPROVED',
          pointsAwarded: pts,
          reviewedAt: new Date(),
          adminFeedback: 'Approved by Darsh'
        };
        memoryDailySubmissions.push(item);
      }
      io.emit('daily_task_submission_updated', {
        submission: item || dbSub,
        submissionId: data.submissionId || (item && item.id),
        approved: true,
        pointsAwarded: pts,
        slotTitle: data.slotTitle || 'Routine Task'
      });
    } else if (data.action === 'DAILY_TASK_REJECTED' && data.submissionId) {
      if (mongoose.connection.readyState === 1) {
        DailyTaskSubmission.findOneAndUpdate(
          { id: data.submissionId },
          { status: 'REJECTED', adminFeedback: data.feedback || '', reviewedAt: new Date() },
          { new: true }
        ).catch(err => console.error('Error rejecting DAILY_TASK in Mongo:', err));
      }
      const item = memoryDailySubmissions.find(s => s.id === data.submissionId);
      if (item) {
        item.status = 'REJECTED';
        item.adminFeedback = data.feedback || '';
        item.reviewedAt = new Date();
      }
      io.emit('daily_task_submission_updated', { submission: item, rejected: true, feedback: data.feedback });
    } else if (data.action === 'DAILY_SLOT_DELETE' && data.slotId) {
      const allDeleted = Array.from(new Set([
        ...(globalLoveBalanceState.deletedSlotIds || []),
        data.slotId,
        ...(Array.isArray(data.deletedSlotIds) ? data.deletedSlotIds : [])
      ]));
      globalLoveBalanceState.deletedSlotIds = allDeleted;
      memoryDailySlots = memoryDailySlots.filter(s => !allDeleted.includes(s.id));
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        DailyTaskSlot.deleteMany({ id: { $in: allDeleted } }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: allDeleted });
    } else if (data.action === 'DAILY_SLOT_UPDATE' && data.slotId) {
      const idx = memoryDailySlots.findIndex(s => s.id === data.slotId);
      if (idx >= 0) {
        memoryDailySlots[idx] = { ...memoryDailySlots[idx], ...data.updates };
        globalLoveBalanceState.dailySlots = memoryDailySlots;
        persistLoveState();
        if (mongoose.connection.readyState === 1) {
          DailyTaskSlot.findOneAndUpdate({ id: data.slotId }, data.updates).catch(() => {});
        }
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: globalLoveBalanceState.deletedSlotIds });
    } else if (data.action === 'DAILY_SLOT_CREATE' && data.slot) {
      globalLoveBalanceState.deletedSlotIds = (globalLoveBalanceState.deletedSlotIds || []).filter(id => id !== data.slot.id);
      const exists = memoryDailySlots.some(s => s.id === data.slot.id);
      if (!exists) {
        memoryDailySlots.push(data.slot);
        globalLoveBalanceState.dailySlots = memoryDailySlots;
        persistLoveState();
        if (mongoose.connection.readyState === 1) {
          DailyTaskSlot.create(data.slot).catch(() => {});
        }
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: globalLoveBalanceState.deletedSlotIds });
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
      originSocketId: socket.id,
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      wishRequests: globalLoveBalanceState.wishRequests,
      deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
      lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
      serverTimestamp: Date.now()
    };
    io.emit('love_balance_broadcast', payload);
  });

  // --- DAILY PROJECTS & HOURLY ROUTINE SOCKET ENGINE ---
  socket.on('daily_task_request_sync', async ({ date }) => {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
      let slots = (memoryDailySlots || []).filter(s => s && !activeDeleted.includes(s.id));
      let submissions = [...memoryDailySubmissions];

      if (mongoose.connection.readyState === 1) {
        try {
          const dbSlots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).sort({ order: 1, createdAt: 1 }).lean();
          if (dbSlots && dbSlots.length > 0) {
            slots = dbSlots;
            memoryDailySlots = dbSlots;
          } else {
            const validDefaults = DEFAULT_DAILY_SLOTS.filter(s => !activeDeleted.includes(s.id));
            if (validDefaults.length > 0) {
              await DailyTaskSlot.insertMany(validDefaults);
              slots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).sort({ order: 1, createdAt: 1 }).lean();
            }
          }
          const dbSubs = await DailyTaskSubmission.find({
            $or: [{ date: targetDate }, { status: 'PENDING' }]
          }).sort({ submittedAt: -1 }).limit(100).lean();
          if (Array.isArray(dbSubs) && dbSubs.length > 0) {
            for (const sub of dbSubs) {
              const idx = submissions.findIndex(s => s.id === sub.id);
              if (idx >= 0) submissions[idx] = sub;
              else submissions.push(sub);
            }
          }
        } catch (dbErr) {
          console.warn("MongoDB sync fallback to memoryDailySubmissions:", dbErr.message);
        }
      }

      socket.emit('daily_task_sync_response', {
        date: targetDate,
        slots,
        submissions,
        deletedSlotIds: activeDeleted
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

      const idx = memoryDailySubmissions.findIndex(s => s.id === submissionId);
      if (idx >= 0) {
        memoryDailySubmissions[idx] = submissionData;
      } else {
        memoryDailySubmissions.push(submissionData);
      }

      if (mongoose.connection.readyState === 1) {
        DailyTaskSubmission.findOneAndUpdate(
          { id: submissionId },
          submissionData,
          { upsert: true, new: true }
        ).catch(err => console.warn("Mongo save warning:", err.message));
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

  socket.on('daily_task_approve', async ({ submissionId, slotId, date, points, feedback, slotTitle }) => {
    try {
      if (!submissionId && !slotId) return;
      const pts = parseFloat(points) || 0;
      let updatedSubmission = null;

      if (mongoose.connection.readyState === 1) {
        const query = submissionId ? { id: submissionId } : { slotId: slotId, date: date };
        updatedSubmission = await DailyTaskSubmission.findOneAndUpdate(
          query,
          {
            status: 'APPROVED',
            pointsAwarded: pts,
            reviewedAt: new Date(),
            adminFeedback: feedback || 'Approved by Darsh'
          },
          { new: true }
        ).lean();
      }

      const memSub = memoryDailySubmissions.find(s => (submissionId && s.id === submissionId) || (slotId && s.slotId === slotId && (!date || s.date === date)));
      if (memSub) {
        memSub.status = 'APPROVED';
        memSub.pointsAwarded = pts;
        memSub.reviewedAt = new Date();
        memSub.adminFeedback = feedback || 'Approved by Darsh';
        if (!updatedSubmission) updatedSubmission = { ...memSub };
      }

      if (!updatedSubmission) {
        updatedSubmission = {
          id: submissionId || `sub_${date || new Date().toISOString().split('T')[0]}_${slotId}`,
          slotId: slotId || '',
          date: date || new Date().toISOString().split('T')[0],
          status: 'APPROVED',
          pointsAwarded: pts,
          reviewedAt: new Date(),
          adminFeedback: feedback || 'Approved by Darsh'
        };
        memoryDailySubmissions.push(updatedSubmission);
      }

      // Award Love Balance points to Dora (deduplicated by submission ID)
      if (pts > 0) {
        const approvalEntryId = 'lb_appr_' + (submissionId || `${date || new Date().toISOString().split('T')[0]}_${slotId}`);
        const taskName = slotTitle || updatedSubmission.slotTitle || 'Daily Routine Task';
        const alreadyExists = (globalLoveBalanceState.loveLedger || []).some(e => 
          e && (e.id === approvalEntryId || (e.description && e.description.includes(`Approved Task: ${taskName}`) && e.earnedAt && e.earnedAt.startsWith(new Date().toLocaleDateString('en-GB'))))
        );
        if (!alreadyExists) {
          const newEntry = {
            id: approvalEntryId,
            sl: 1,
            target: 'user',
            description: '[Dora] Approved Task: ' + taskName,
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
            reason: 'Daily Task Approved: ' + taskName,
            newEntry,
            currentLoveBalance: globalLoveBalanceState.loveBalance,
            currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
            serverTimestamp: Date.now()
          });
        }
      }

      io.emit('daily_task_submission_updated', {
        submission: updatedSubmission,
        submissionId: submissionId || (updatedSubmission && updatedSubmission.id),
        approved: true,
        pointsAwarded: pts,
        slotTitle: slotTitle || (updatedSubmission && updatedSubmission.slotTitle) || 'Routine Task'
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
        id: slotData.id || ('slot_' + Date.now()),
        title: slotData.title || 'New Routine Task',
        timeRange: slotData.timeRange || '09:00 - 10:00',
        tag: slotData.tag || 'Task',
        rewardPoints: parseFloat(slotData.rewardPoints) || 1.0,
        order: parseInt(slotData.order) || (memoryDailySlots.length + 1),
        isActive: true
      };

      globalLoveBalanceState.deletedSlotIds = (globalLoveBalanceState.deletedSlotIds || []).filter(id => id !== newSlot.id);
      const exists = memoryDailySlots.some(s => s.id === newSlot.id);
      if (!exists) memoryDailySlots.push(newSlot);
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();

      if (mongoose.connection.readyState === 1) {
        DailyTaskSlot.create(newSlot).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: globalLoveBalanceState.deletedSlotIds });
    } catch (err) {
      console.error('Error in daily_slot_create:', err);
    }
  });

  socket.on('daily_slot_update', async ({ slotId, updates }) => {
    try {
      if (!slotId) return;
      const idx = memoryDailySlots.findIndex(s => s.id === slotId);
      if (idx >= 0) {
        memoryDailySlots[idx] = { ...memoryDailySlots[idx], ...updates };
      }
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        DailyTaskSlot.findOneAndUpdate({ id: slotId }, updates, { new: true }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: globalLoveBalanceState.deletedSlotIds });
    } catch (err) {
      console.error('Error in daily_slot_update:', err);
    }
  });

  socket.on('daily_slot_delete', async ({ slotId, deletedSlotIds }) => {
    try {
      if (!slotId) return;
      const allDeleted = Array.from(new Set([
        ...(globalLoveBalanceState.deletedSlotIds || []),
        slotId,
        ...(Array.isArray(deletedSlotIds) ? deletedSlotIds : [])
      ]));
      globalLoveBalanceState.deletedSlotIds = allDeleted;
      memoryDailySlots = memoryDailySlots.filter(s => !allDeleted.includes(s.id));
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        await DailyTaskSlot.deleteMany({ id: { $in: allDeleted } }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: allDeleted });
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