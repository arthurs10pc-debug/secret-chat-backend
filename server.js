require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const CryptoJS = require('crypto-js');

const SECRET_KEY = "StealthMasterKey99";

function decryptText(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return '';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8) || '';
  } catch (e) {
    return '';
  }
}

const app = express();
const server = http.createServer(app);

// Enable Gzip/Brotli wire compression for lightning-fast API responses
app.use(compression());

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

// --- WEB PUSH NOTIFICATIONS ENGINE ---
let webpush = null;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BLGlvaIiH3UdH3hCrmFmiWV3jKRRAKnR2rv7lmiq7hofrpjEU_13EcpzcBeil9BxDisRr3IhxSuANyJi3-N5JlU';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'MyNDS9SQu5HZdKJJR7J_luI0wuFhNcH3YzmUUlImeW0';

import('web-push').then(wp => {
  webpush = wp;
  webpush.setVapidDetails(
    'mailto:arthurs10pc@gmail.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('[WebPush] VAPID details registered successfully.');
}).catch(err => {
  console.warn('[WebPush] Initialization warning:', err.message);
});

const pushSubscriptions = new Map(); // endpoint -> { subscription, role, email, updatedAt }

let globalLoveBalanceState = {
  activeDoraEmail: '',
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

  return round2(credits - debits - redeems);
}

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function getISTDate(date = new Date()) {
  const d = new Date(date);
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(d.getTime() + istOffset);
}

function getISTDateString(date = new Date()) {
  return getISTDate(date).toISOString().split('T')[0];
}

function computeAuditHash(entry, prevHash = 'GENESIS_BLOCK_0') {
  const payload = `${prevHash}|${entry.id}|${entry.target}|${round2(entry.points)}|${entry.type}|${entry.earnedAt}|${entry.remarks || ''}`;
  return CryptoJS.SHA256(payload).toString().substring(0, 16);
}

function getNowIstEarnedAt() {
  const d = new Date();
  const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase();
  return `${dateStr}, ${timeStr}`;
}

function isSocketAdmin(socket, data = {}) {
  const role = socket.role || data.senderRole || data.role;
  const email = (socket.userEmail || data.userEmail || data.email || '').toLowerCase();
  return role === 'parent' || role === 'admin' || email === 'arthurs10pc@gmail.com';
}

const DARSH_BASE_TX_ID = 'lb_darsh_base_points_71';

function syncBalancesFromLedger() {
  if (!Array.isArray(globalLoveBalanceState.loveLedger)) {
    globalLoveBalanceState.loveLedger = [];
  }

  globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
  globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
}

const SYSTEM_START_DATE = '2026-11-17';

function sanitizeLedger(ledger) {
  if (!Array.isArray(ledger)) return [];
  const seen = new Set();
  const cleaned = [];
  let prevHash = 'GENESIS_BLOCK_0';
  const lastInstantReplyMap = {};

  for (const item of ledger) {
    if (!item) continue;
    if (item.id && seen.has(item.id)) continue;
    // Purge legacy mock template items
    if (item.id && /^lb_([1-9]|1[0-1])$/.test(item.id)) continue;
    if (item.description && (
      item.description.includes('Announcement Read') ||
      item.description.includes('Monthly Punctuality Reward')
    )) continue;
    // Purge any auto-habit or missed penalties from before today (Nov 17, 2026 onwards system)
    if (item.id && (item.id.startsWith('habit_') || item.id.startsWith('penalty_'))) {
      const dateMatch = (item.id + ' ' + (item.description || '')).match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && dateMatch[1] < SYSTEM_START_DATE) {
        continue;
      }
    }

    // Convert any legacy UTC "DD/MM/YYYY, HH:mm:ss" strings to proper IST "YYYY-MM-DD, h:mm am/pm"
    const gbMatch = String(item.earnedAt || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (gbMatch) {
      const [, day, month, year, h, m, s] = gbMatch;
      const utcDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(h), Number(m), Number(s || 0)));
      const dateStr = utcDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const timeStr = utcDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase();
      item.earnedAt = `${dateStr}, ${timeStr}`;
    }

    // Update Instant Reply points to 0.50
    if (item.description && item.description.includes('Instant Reply')) {
      item.description = item.description.replace(/Within (?:5|1) Mins?/gi, 'Within 30 Sec');
      if (item.remarks) item.remarks = item.remarks.replace(/Within (?:5|1) Mins?/gi, 'Within 30 Sec');
      item.points = 0.50;
      const targetKey = item.target || 'user';
      let entryTimeMs = 0;
      if (item.id && item.id.startsWith('lb_instant_')) {
        const parts = item.id.split('_');
        entryTimeMs = parseInt(parts[2], 10);
      }
      if (isNaN(entryTimeMs) || entryTimeMs === 0) {
        if (gbMatch) {
          entryTimeMs = Date.UTC(Number(gbMatch[3]), Number(gbMatch[2]) - 1, Number(gbMatch[1]), Number(gbMatch[4]), Number(gbMatch[5]), Number(gbMatch[6] || 0));
        } else {
          try {
            entryTimeMs = new Date(item.earnedAt).getTime();
          } catch (e) {}
        }
      }
      if (entryTimeMs > 0) {
        if (!lastInstantReplyMap[targetKey]) {
          lastInstantReplyMap[targetKey] = entryTimeMs;
        } else {
          // If within 5 minutes of another instant reply for same target, skip duplicate!
          if (Math.abs(lastInstantReplyMap[targetKey] - entryTimeMs) < 5 * 60 * 1000) {
            continue;
          }
          lastInstantReplyMap[targetKey] = entryTimeMs;
        }
      }
    }

    // Update Deep Romantic Long Message points to 1.00
    if (item.description && (item.description.includes('Deep Romantic Long Message') || item.description.includes('Romantic Paragraph'))) {
      item.points = 1.00;
    }

    item.points = round2(item.points);
    if (!item.auditHash) {
      item.auditHash = computeAuditHash(item, prevHash);
    }
    prevHash = item.auditHash;
    if (item.id) seen.add(item.id);
    cleaned.push(item);
  }
  return cleaned;
}

try {
  if (fs.existsSync(LOVE_STATE_FILE)) {
    const raw = fs.readFileSync(LOVE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      globalLoveBalanceState = {
        activeDoraEmail: (parsed.activeDoraEmail && parsed.activeDoraEmail.toLowerCase() !== 'dora@gmail.com') ? parsed.activeDoraEmail : '',
        loveBalance: typeof parsed.loveBalance === 'number' ? parsed.loveBalance : 0,
        adminLoveBalance: typeof parsed.adminLoveBalance === 'number' ? parsed.adminLoveBalance : 0,
        loveLedger: sanitizeLedger(parsed.loveLedger),
        wishRequests: Array.isArray(parsed.wishRequests) ? parsed.wishRequests : [],
        deletedSlotIds: Array.isArray(parsed.deletedSlotIds) ? parsed.deletedSlotIds : [],
        deletedTransactionIds: Array.isArray(parsed.deletedTransactionIds) ? parsed.deletedTransactionIds : [],
        lastClearedAt: typeof parsed.lastClearedAt === 'number' ? parsed.lastClearedAt : 0,
        userLastClearedAt: typeof parsed.userLastClearedAt === 'number' ? parsed.userLastClearedAt : 0,
        adminLastClearedAt: typeof parsed.adminLastClearedAt === 'number' ? parsed.adminLastClearedAt : 0,
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
  activeDoraEmail: { type: String, default: '' },
  loveBalance: { type: Number, default: 0 },
  adminLoveBalance: { type: Number, default: 0 },
  loveLedger: { type: Array, default: [] },
  wishRequests: { type: Array, default: [] },
  deletedSlotIds: { type: Array, default: [] },
  deletedTransactionIds: { type: Array, default: [] },
  lastClearedAt: { type: Number, default: 0 },
  userLastClearedAt: { type: Number, default: 0 },
  adminLastClearedAt: { type: Number, default: 0 },
  dailySlots: { type: Array, default: [] }
}, { timestamps: true });

const LoveBalanceModel = mongoose.model('LoveBalance', loveBalanceSchema);

const pushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: String,
    auth: String
  },
  role: { type: String, default: 'user' },
  email: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const PushSubscriptionModel = mongoose.model('PushSubscription', pushSubscriptionSchema);

async function loadPushSubscriptions() {
  try {
    const subs = await PushSubscriptionModel.find({});
    for (const s of subs) {
      if (s.endpoint && s.keys) {
        pushSubscriptions.set(s.endpoint, {
          subscription: {
            endpoint: s.endpoint,
            keys: {
              p256dh: s.keys.p256dh,
              auth: s.keys.auth
            }
          },
          role: s.role || 'user',
          email: s.email || ''
        });
      }
    }
    console.log(`[WebPush] Loaded ${pushSubscriptions.size} push subscriptions from MongoDB.`);
  } catch (err) {
    console.warn('[WebPush] Could not load push subscriptions from DB:', err.message);
  }
}
setTimeout(loadPushSubscriptions, 2000);

async function sendWebPushNotification({ title, body, icon = '/favicon.ico', targetRole = null, data = {} }) {
  if (!webpush) return;
  const payload = JSON.stringify({
    title: title || 'ChatGPT',
    body: body || '',
    icon,
    data: {
      url: '/',
      ...data
    }
  });

  const deadEndpoints = [];
  for (const [endpoint, subObj] of pushSubscriptions.entries()) {
    if (targetRole) {
      const isSubAdmin = subObj.role === 'parent' || subObj.role === 'admin' || (subObj.email && subObj.email.toLowerCase() === 'arthurs10pc@gmail.com');
      const isTargetAdmin = targetRole === 'parent' || targetRole === 'admin';
      if (isSubAdmin !== isTargetAdmin) {
        continue;
      }
    }

    try {
      await webpush.sendNotification(subObj.subscription, payload);
      console.log(`[WebPush] Sent notification to ${subObj.role} (${subObj.email || 'anon'}): "${title}"`);
    } catch (err) {
      console.warn(`[WebPush] Send notification error:`, err.statusCode || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        deadEndpoints.push(endpoint);
      }
    }
  }

  for (const ep of deadEndpoints) {
    pushSubscriptions.delete(ep);
    try {
      await PushSubscriptionModel.deleteOne({ endpoint: ep });
    } catch (e) {}
  }
}

function persistLoveState() {
  if (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === 'dora@gmail.com') {
    globalLoveBalanceState.activeDoraEmail = '';
  }
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
          activeDoraEmail: (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() !== 'dora@gmail.com') ? globalLoveBalanceState.activeDoraEmail : '',
          loveBalance: globalLoveBalanceState.loveBalance,
          adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          loveLedger: globalLoveBalanceState.loveLedger,
          wishRequests: globalLoveBalanceState.wishRequests,
          deletedSlotIds: globalLoveBalanceState.deletedSlotIds,
          deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds,
          lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
          userLastClearedAt: globalLoveBalanceState.userLastClearedAt || 0,
          adminLastClearedAt: globalLoveBalanceState.adminLastClearedAt || 0,
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
      // Pre-load past 30 days messages & submissions so habit evaluation and history are 100% accurate
      const past30Days = new Date(Date.now() - 30 * 86400000);
      const dbMsgs = await Message.find({ timestamp: { $gte: past30Days } }).lean();
      if (Array.isArray(dbMsgs) && dbMsgs.length > 0) {
        memoryMessages.length = 0;
        memoryMessages.push(...dbMsgs.map(m => ({ ...m, text: m.text || decryptText(m.encryptedText) })));
      }
      const dbSubs = await DailyTaskSubmission.find({ createdAt: { $gte: past30Days } }).lean();
      if (Array.isArray(dbSubs) && dbSubs.length > 0) {
        memoryDailySubmissions.length = 0;
        memoryDailySubmissions.push(...dbSubs);
      }

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
        if (typeof doc.userLastClearedAt === 'number') {
          globalLoveBalanceState.userLastClearedAt = doc.userLastClearedAt;
        }
        if (typeof doc.adminLastClearedAt === 'number') {
          globalLoveBalanceState.adminLastClearedAt = doc.adminLastClearedAt;
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
          memoryDailySlots = sortSlotsByTime(globalLoveBalanceState.dailySlots);
        }
        if (doc.activeDoraEmail && doc.activeDoraEmail.toLowerCase() !== 'dora@gmail.com') {
          globalLoveBalanceState.activeDoraEmail = doc.activeDoraEmail;
        } else {
          globalLoveBalanceState.activeDoraEmail = '';
        }
        syncBalancesFromLedger();
        persistLoveState();
        syncActiveDoraUserBalance();
        console.log("Synchronized Love Balance from MongoDB: Dora ₹", globalLoveBalanceState.loveBalance, "| Darsh ₹", globalLoveBalanceState.adminLoveBalance);
      }

      // Permanently purge mock/demo account 'dora@gmail.com' from Mongo
      await UserModel.deleteMany({ email: { $in: ['dora@gmail.com', 'dora'] } }).catch(() => {});
      memoryUsers.delete('dora@gmail.com');
      if (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === 'dora@gmail.com') {
        globalLoveBalanceState.activeDoraEmail = '';
      }

      // Preload all registered users from MongoDB into memoryUsers (excluding any demo id)
      const dbUsers = await UserModel.find({ email: { $ne: 'dora@gmail.com' } }).lean();
      if (Array.isArray(dbUsers) && dbUsers.length > 0) {
        dbUsers.forEach(u => {
          if (u && u.email && u.email.toLowerCase() !== 'dora@gmail.com') {
            const k = u.email.toLowerCase();
            const isAdmin = k === 'arthurs10pc@gmail.com';
            const isDora = isAdmin ? false : (
              Boolean(u.isDora) || 
              (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === k)
            );
            memoryUsers.set(k, {
              ...u,
              email: k,
              name: u.name || (isAdmin ? 'Darsh' : (u.firstName || 'User')),
              firstName: u.firstName || (isAdmin ? 'Darsh' : 'User'),
              fullName: u.fullName || u.originalName || u.name || '',
              role: isAdmin ? 'parent' : 'user',
              isAdmin,
              isDora,
              loveBalance: typeof u.loveBalance === 'number' ? u.loveBalance : 0,
              loveLedger: Array.isArray(u.loveLedger) ? u.loveLedger : []
            });
          }
        });
      }

      if (globalLoveBalanceState.activeDoraEmail) {
        const dEmail = globalLoveBalanceState.activeDoraEmail.toLowerCase();
        const dUser = memoryUsers.get(dEmail);
        if (dUser) {
          dUser.isDora = true;
          memoryUsers.set(dEmail, dUser);
        }
        await UserModel.updateOne({ email: dEmail }, { $set: { isDora: true } }).catch(() => {});
        await UserModel.updateMany({ email: { $nin: [dEmail, 'arthurs10pc@gmail.com'] } }, { $set: { isDora: false } }).catch(() => {});
      } else {
        const activeDora = Array.from(memoryUsers.values()).find(u => !u.isAdmin && u.isDora);
        if (activeDora) {
          globalLoveBalanceState.activeDoraEmail = activeDora.email;
          if (typeof activeDora.loveBalance === 'number') {
            globalLoveBalanceState.loveBalance = activeDora.loveBalance;
          }
          if (Array.isArray(activeDora.loveLedger) && activeDora.loveLedger.length > 0) {
            const adminTxs = (globalLoveBalanceState.loveLedger || []).filter(e => e && (e.target === 'admin' || (e.description && e.description.includes('[Darsh]'))));
            globalLoveBalanceState.loveLedger = sanitizeLedger([...activeDora.loveLedger, ...adminTxs]);
          }
          persistLoveState();
        }
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
  mediaType: { type: String, default: 'text' },
  mediaOpened: { type: Boolean, default: false },
  reaction: { type: String, default: null },
  isPinned: { type: Boolean, default: false },
  isStarred: { type: Boolean, default: false },
  replyRefId: { type: String, default: null }
});

// Database indexes for millisecond query performance
messageSchema.index({ room: 1, timestamp: -1 });
messageSchema.index({ room: 1, isSeen: 1 });

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

dailyTaskSubmissionSchema.index({ date: 1, slotId: 1 });

const DailyTaskSubmission = mongoose.model('DailyTaskSubmission', dailyTaskSubmissionSchema);

const DEFAULT_DAILY_SLOTS = [
  { id: 'slot_1', title: 'Morning Workout (10 Squats / Stretch)', timeRange: '07:00 - 08:00', tag: 'Workout', rewardPoints: 2.0, order: 1, isActive: true },
  { id: 'slot_2', title: 'Healthy Detox Juice / Morning Drink', timeRange: '09:00 - 10:00', tag: 'Juice', rewardPoints: 1.5, order: 2, isActive: true },
  { id: 'slot_3', title: 'Heavy Breakfast (High-Calorie Meal Plate)', timeRange: '10:00 - 11:00', tag: 'Breakfast', rewardPoints: 2.5, order: 3, isActive: true },
  { id: 'slot_4', title: 'Lunch Check-in & Care Update', timeRange: '13:00 - 14:00', tag: 'Lunch', rewardPoints: 2.0, order: 4, isActive: true },
  { id: 'slot_5', title: 'Hydration Milestone (Water Intake)', timeRange: '15:30 - 16:30', tag: 'Water', rewardPoints: 1.0, order: 5, isActive: true },
  { id: 'slot_6', title: 'Evening Tea & Healthy Snack', timeRange: '17:00 - 17:30', tag: 'Tea', rewardPoints: 1.0, order: 6, isActive: true },
  { id: 'slot_7', title: 'High-Protein Dinner Plate', timeRange: '20:30 - 21:30', tag: 'Dinner', rewardPoints: 2.0, order: 7, isActive: true },
  { id: 'slot_8', title: 'Google Fit 8,000 Steps Screenshot', timeRange: '22:00 - 22:30', tag: 'Steps', rewardPoints: 3.0, order: 8, isActive: true },
  { id: 'slot_9', title: 'Night Skin Care Routine & Glow Check', timeRange: '22:30 - 23:00', tag: 'Skincare', rewardPoints: 2.0, order: 9, isActive: true }
];

const normalizeSlotTimeRange = (slot) => {
  if (!slot || !slot.timeRange) return slot;
  let tr = String(slot.timeRange).trim();
  const lower = ((slot.tag || '') + ' ' + (slot.title || '')).toLowerCase();

  if (lower.includes('dinner') && /^0?8:30\s*-\s*0?9:30/i.test(tr)) {
    tr = '20:30 - 21:30';
  } else if (lower.includes('steps') && /^10:00\s*-\s*10:30/i.test(tr)) {
    tr = '22:00 - 22:30';
  } else if ((lower.includes('night') || lower.includes('skincare')) && /^10:30\s*-\s*11:00/i.test(tr)) {
    tr = '22:30 - 23:00';
  } else if ((lower.includes('lunch') || lower.includes('tifin') || lower.includes('tiffin')) && /^0?1:00\s*-\s*0?2:00/i.test(tr)) {
    tr = '13:00 - 14:00';
  } else if (lower.includes('water') && /^0?3:30\s*-\s*0?4:30/i.test(tr)) {
    tr = '15:30 - 16:30';
  } else if (lower.includes('tea') && /^0?5:00\s*-\s*0?5:30/i.test(tr)) {
    tr = '17:00 - 17:30';
  }

  return { ...slot, timeRange: tr };
};

const getSlotTimeSortMinutes = (slot) => {
  if (!slot || !slot.timeRange) return 9999;
  try {
    const rawStart = String(slot.timeRange).split('-')[0].trim();
    const isPm = /pm/i.test(slot.timeRange) || /pm/i.test(rawStart);
    const isAm = /am/i.test(slot.timeRange) || /am/i.test(rawStart);

    const m = rawStart.match(/(\d{1,2}):(\d{2})/);
    if (!m) return 9999;
    let h = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);

    if (isPm && h < 12) h += 12;
    if (isAm && h === 12) h = 0;

    if (!isPm && !isAm) {
      const lower = ((slot.tag || '') + ' ' + (slot.title || '')).toLowerCase();
      if (lower.includes('dinner') && h < 12) {
        h += 12;
      } else if ((lower.includes('night') || lower.includes('skincare') || lower.includes('steps')) && h < 12) {
        h += 12;
      } else if (lower.includes('tea') && h < 12 && h <= 8) {
        h += 12;
      } else if ((lower.includes('lunch') || lower.includes('tifin') || lower.includes('tiffin')) && h < 12 && h <= 5) {
        h += 12;
      }
    }

    return h * 60 + mins;
  } catch {
    return 9999;
  }
};

const sortSlotsByTime = (slots) => {
  if (!Array.isArray(slots)) return [];
  return slots
    .map(normalizeSlotTimeRange)
    .sort((a, b) => {
      const diff = getSlotTimeSortMinutes(a) - getSlotTimeSortMinutes(b);
      if (diff !== 0) return diff;
      return (a.order || 0) - (b.order || 0);
    });
};

let memoryDailySlots = sortSlotsByTime([...DEFAULT_DAILY_SLOTS]);
let memoryDailySubmissions = [];

async function seedDefaultSlotsIfEmpty() {
  try {
    const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
    if (mongoose.connection.readyState === 1) {
      // Migrate any legacy 12hr slot timeRanges to standard 24hr format
      await DailyTaskSlot.updateMany({ id: 'slot_1', timeRange: '08:00 - 09:00' }, { $set: { timeRange: '07:00 - 08:00' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_4', timeRange: '01:00 - 02:00' }, { $set: { timeRange: '13:00 - 14:00' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_5', timeRange: '03:30 - 04:30' }, { $set: { timeRange: '15:30 - 16:30' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_6', timeRange: '05:00 - 05:30' }, { $set: { timeRange: '17:00 - 17:30' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_7', timeRange: '08:30 - 09:30' }, { $set: { timeRange: '20:30 - 21:30' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_8', timeRange: '10:00 - 10:30' }, { $set: { timeRange: '22:00 - 22:30' } }).catch(() => {});
      await DailyTaskSlot.updateMany({ id: 'slot_9', timeRange: '10:30 - 11:00' }, { $set: { timeRange: '22:30 - 23:00' } }).catch(() => {});

      const existingCount = await DailyTaskSlot.countDocuments().catch(() => 0);
      if (existingCount === 0) {
        for (const slot of DEFAULT_DAILY_SLOTS) {
          if (!activeDeleted.includes(slot.id)) {
            await DailyTaskSlot.findOneAndUpdate(
              { id: slot.id },
              slot,
              { upsert: true, new: true }
            ).catch(() => {});
          }
        }
        console.log('Seeded initial default daily task slots.');
      }
      // Always hydrate memoryDailySlots from MongoDB so custom slots are never lost
      const dbSlots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).lean();
      if (Array.isArray(dbSlots) && dbSlots.length > 0) {
        memoryDailySlots = sortSlotsByTime(dbSlots);
        globalLoveBalanceState.dailySlots = memoryDailySlots;
        return;
      }
    }

    const map = new Map();
    DEFAULT_DAILY_SLOTS.filter(d => !activeDeleted.includes(d.id)).forEach(d => map.set(d.id, d));
    (memoryDailySlots || []).filter(s => s && s.id && !activeDeleted.includes(s.id)).forEach(s => map.set(s.id, s));
    if (Array.isArray(globalLoveBalanceState.dailySlots)) {
      globalLoveBalanceState.dailySlots.filter(s => s && s.id && !activeDeleted.includes(s.id)).forEach(s => map.set(s.id, s));
    }
    memoryDailySlots = sortSlotsByTime(
      Array.from(map.values()).filter(s => s && !activeDeleted.includes(s.id))
    );
    globalLoveBalanceState.dailySlots = memoryDailySlots;
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
  lastUpdated: Date.now(),
  queue: [null, null, null],
  lastAdvanceTime: 0
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
  res.send({ status: "Online", service: "Stealth Secret Chat & Arcade Engine v19", buildTime: new Date().toISOString() });
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

// Full authoritative chat history API for instant full export and complete sync
app.get('/api/chat-history', async (req, res) => {
  const room = req.query.room || 'stealth_master_room';
  try {
    let history = [];
    if (mongoose.connection.readyState === 1) {
      history = await Message.find({ room }).sort({ timestamp: 1 }).lean();
    } else {
      history = memoryMessages.filter(m => m.room === room);
    }
    res.json(history);
  } catch (err) {
    console.error("Error fetching chat-history:", err);
    res.json(memoryMessages.filter(m => m.room === room));
  }
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  firstName: { type: String, default: '' },
  fullName: { type: String, default: '' },
  originalName: { type: String, default: '' },
  role: { type: String, default: 'user' },
  picture: { type: String, default: '' },
  isDora: { type: Boolean, default: false },
  doraAssignedAt: { type: Date },
  assignedBy: { type: String, default: '' },
  loveBalance: { type: Number, default: 0 },
  loveLedger: { type: Array, default: [] },
  lastLogin: { type: Date, default: Date.now }
});

userSchema.index({ isDora: 1 });

const UserModel = mongoose.model('User', userSchema);

// Memory fallback directory for instant reactivity across all devices
const memoryUsers = new Map();
memoryUsers.set('arthurs10pc@gmail.com', {
  email: 'arthurs10pc@gmail.com',
  name: 'Darsh',
  firstName: 'Darsh',
  fullName: 'Darsh (Admin)',
  originalName: 'Darsh (Admin)',
  role: 'parent',
  isAdmin: true,
  isDora: false,
  picture: 'https://lh3.googleusercontent.com/a/default-user',
  loveBalance: 0,
  loveLedger: [],
  lastLogin: new Date()
});

app.post('/api/save-subscription', express.json(), async (req, res) => {
  try {
    const { subscription, role, email } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanRole = role || 'user';
    pushSubscriptions.set(subscription.endpoint, {
      subscription,
      role: cleanRole,
      email: cleanEmail
    });

    try {
      await PushSubscriptionModel.findOneAndUpdate(
        { endpoint: subscription.endpoint },
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys || {},
          role: cleanRole,
          email: cleanEmail,
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );
    } catch (dbErr) {
      console.warn('[WebPush] DB save error:', dbErr.message);
    }

    console.log(`[WebPush] Subscription saved for role=${cleanRole}, email=${cleanEmail}. Total active: ${pushSubscriptions.size}`);

    sendWebPushNotification({
      title: '🔔 Alerts Connected!',
      body: 'You will now receive all updates and points here on your mobile screen.',
      targetRole: cleanRole,
      data: { type: 'test' }
    });

    return res.json({ success: true, count: pushSubscriptions.size });
  } catch (err) {
    console.error('[WebPush] save-subscription error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/google-login', async (req, res) => {
  try {
    const { email, name, picture } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'dora@gmail.com') {
      return res.status(400).json({ error: 'Demo account is disabled. Please login with a real Gmail account.' });
    }
    const isAdmin = cleanEmail === 'arthurs10pc@gmail.com';
    const role = isAdmin ? 'parent' : 'user';
    const fullName = name || (isAdmin ? 'Darsh' : 'User');
    const firstName = fullName.trim().split(' ')[0] || fullName;
    const displayName = isAdmin ? 'Darsh' : firstName;

    // Check if user already exists to preserve isDora status and balance
    let existing = memoryUsers.get(cleanEmail);
    if (!existing && mongoose.connection.readyState === 1) {
      try {
        existing = await UserModel.findOne({ email: cleanEmail }).lean();
      } catch (err) {}
    }
    const isDora = isAdmin ? false : (
      Boolean(existing?.isDora) || 
      (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === cleanEmail)
    );
    const incomingBal = typeof req.body.loveBalance === 'number' ? req.body.loveBalance : parseFloat(req.body.loveBalance);
    const incomingLedger = Array.isArray(req.body.loveLedger) ? req.body.loveLedger : [];

    let userLoveBalance = 0;
    if (!isNaN(incomingBal) && incomingBal > 0) {
      userLoveBalance = incomingBal;
    } else if (typeof existing?.loveBalance === 'number' && existing.loveBalance > 0) {
      userLoveBalance = existing.loveBalance;
    }
    const userLoveLedger = incomingLedger.length > 0 ? incomingLedger : (Array.isArray(existing?.loveLedger) ? existing.loveLedger : []);

    const userObj = {
      email: cleanEmail,
      name: displayName,
      firstName,
      fullName,
      originalName: name || fullName,
      role,
      picture: picture || '',
      isAdmin,
      isDora,
      loveBalance: userLoveBalance,
      loveLedger: userLoveLedger,
      lastLogin: new Date()
    };

    memoryUsers.set(cleanEmail, userObj);

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { email: cleanEmail },
          userObj,
          { upsert: true, new: true }
        );
      } catch (err) {
        console.warn('Could not save user in mongo:', err.message);
      }
    }

    if (isDora) {
      globalLoveBalanceState.activeDoraEmail = cleanEmail;
      if (userLoveBalance > 0) {
        globalLoveBalanceState.loveBalance = userLoveBalance;
      }
      if (userLoveLedger.length > 0) {
        const adminTxs = (globalLoveBalanceState.loveLedger || []).filter(e => e && (e.target === 'admin' || (e.description && e.description.includes('[Darsh]'))));
        globalLoveBalanceState.loveLedger = sanitizeLedger([...userLoveLedger, ...adminTxs]);
      }
      persistLoveState();
    }

    broadcastUsersDirectory();
    return res.json({ success: true, user: userObj });
  } catch (e) {
    console.error('Google login error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/current-user', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.json({ user: null });
  const isAdmin = email === 'arthurs10pc@gmail.com';
  const existing = memoryUsers.get(email);
  return res.json({
    user: {
      email,
      role: isAdmin ? 'parent' : 'user',
      name: isAdmin ? 'Darsh' : (existing?.name || 'User'),
      firstName: isAdmin ? 'Darsh' : (existing?.firstName || 'User'),
      isAdmin,
      isDora: isAdmin ? false : (Boolean(existing?.isDora) || (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === email)),
      loveBalance: typeof existing?.loveBalance === 'number' ? existing.loveBalance : 0
    }
  });
});

async function switchActiveDora(cleanEmail, isDora = true, adminEmail = 'arthurs10pc@gmail.com') {
  if (!cleanEmail || cleanEmail === 'arthurs10pc@gmail.com') return null;

  // 1. Fetch user from memory or Mongo
  let user = memoryUsers.get(cleanEmail);
  if (!user && mongoose.connection.readyState === 1) {
    try {
      const dbDoc = await UserModel.findOne({ email: cleanEmail }).lean();
      if (dbDoc) user = { ...dbDoc };
    } catch (e) {}
  }

  // If user still doesn't exist, create a clean profile with parsed name
  if (!user) {
    const rawName = cleanEmail.split('@')[0];
    const capitalized = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    user = {
      email: cleanEmail,
      name: capitalized,
      firstName: capitalized,
      fullName: capitalized + ' (User)',
      role: 'user',
      isAdmin: false,
      isDora: Boolean(isDora),
      picture: '',
      loveBalance: 0,
      loveLedger: [],
      lastLogin: new Date()
    };
  }

  // 2. If making this user Dora:
  if (Boolean(isDora)) {
    // Un-assign Dora from all other users in memory
    memoryUsers.forEach((u, k) => {
      if (k !== cleanEmail) u.isDora = false;
    });

    // Un-assign Dora from all other users in MongoDB
    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.updateMany({ email: { $ne: cleanEmail } }, { isDora: false });
      } catch (err) {}
    }

    user.isDora = true;
    user.doraAssignedAt = new Date();
    user.assignedBy = adminEmail;
    memoryUsers.set(cleanEmail, user);

    // Save to Mongo
    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { email: cleanEmail },
          {
            $set: {
              isDora: true,
              doraAssignedAt: new Date(),
              assignedBy: adminEmail,
              name: user.name,
              firstName: user.firstName,
              role: 'user',
              isAdmin: false,
              loveBalance: typeof user.loveBalance === 'number' ? user.loveBalance : 0
            }
          },
          { upsert: true, new: true }
        );
      } catch (err) {}
    }

    // Determine target user's balance & ledger
    const targetLedger = Array.isArray(user.loveLedger) ? user.loveLedger : [];
    let targetBalance = 0;
    if (typeof user.loveBalance === 'number' && user.loveBalance > 0) {
      targetBalance = user.loveBalance;
    } else if (targetLedger.length > 0) {
      targetBalance = calculateNetBalance(targetLedger, 'user');
    } else if (globalLoveBalanceState.loveBalance > 0) {
      targetBalance = globalLoveBalanceState.loveBalance;
    } else {
      targetBalance = 0;
    }

    user.loveBalance = targetBalance;

    // Keep admin ledger entries intact
    const adminEntries = (globalLoveBalanceState.loveLedger || []).filter(e => e && (e.target === 'admin' || (e.description && e.description.includes('[Darsh]'))));

    globalLoveBalanceState.activeDoraEmail = cleanEmail;
    globalLoveBalanceState.loveBalance = targetBalance;
    globalLoveBalanceState.loveLedger = sanitizeLedger([...targetLedger, ...adminEntries]);
    persistLoveState();
    io.emit('request_peer_balance', { email: cleanEmail });
  } else {
    // Revoking Dora role
    user.isDora = false;
    memoryUsers.set(cleanEmail, user);
    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate({ email: cleanEmail }, { $set: { isDora: false } });
      } catch (err) {}
    }
    // Clear active Dora state
    globalLoveBalanceState.activeDoraEmail = '';
    globalLoveBalanceState.loveBalance = 0;
    persistLoveState();
  }

  // 3. Real-time broadcasts to both Admin & Dora screens
  const activeName = Boolean(isDora) ? (user.firstName || user.name || cleanEmail.split('@')[0]) : 'Dora';
  const payload = {
    email: cleanEmail,
    isDora: Boolean(isDora),
    name: user.name,
    firstName: activeName,
    activeDoraName: activeName,
    activeDoraEmail: Boolean(isDora) ? cleanEmail : (globalLoveBalanceState.activeDoraEmail || ''),
    loveBalance: globalLoveBalanceState.loveBalance,
    adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    currentLoveBalance: globalLoveBalanceState.loveBalance,
    currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    loveLedger: globalLoveBalanceState.loveLedger,
    serverTimestamp: Date.now()
  };

  io.emit('dora_status_update', payload);
  io.emit('love_balance_broadcast', {
    ...payload,
    action: 'DORA_SWITCHED'
  });
  io.emit('love_balance_heartbeat_sync', {
    ...payload,
    dailySubmissions: memoryDailySubmissions,
    dailySlots: memoryDailySlots,
    deletedSlotIds: globalLoveBalanceState.deletedSlotIds || [],
    deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || []
  });

  broadcastUsersDirectory();
  return { success: true, user, balance: globalLoveBalanceState.loveBalance };
}

function syncActiveDoraUserBalance() {
  const activeEmail = (globalLoveBalanceState.activeDoraEmail || '').toLowerCase().trim();
  if (!activeEmail || activeEmail === 'dora@gmail.com') return;
  let doraUser = memoryUsers.get(activeEmail);
  if (!doraUser) {
    doraUser = {
      email: activeEmail,
      name: activeEmail.split('@')[0],
      firstName: activeEmail.split('@')[0],
      role: 'user',
      isAdmin: false,
      isDora: true,
      loveBalance: globalLoveBalanceState.loveBalance,
      loveLedger: []
    };
    memoryUsers.set(activeEmail, doraUser);
  }
  const userLedger = (globalLoveBalanceState.loveLedger || []).filter(e => e && e.target !== 'admin' && !(e.description && e.description.includes('[Darsh]')));
  doraUser.loveBalance = globalLoveBalanceState.loveBalance;
  doraUser.loveLedger = userLedger;
  if (mongoose.connection.readyState === 1) {
    UserModel.findOneAndUpdate(
      { email: activeEmail },
      { $set: { loveBalance: globalLoveBalanceState.loveBalance, loveLedger: userLedger } },
      { upsert: true }
    ).catch(() => {});
  }
}

app.post('/api/user/sync-state', async (req, res) => {
  try {
    const { email, loveBalance, loveLedger } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const cleanEmail = email.toLowerCase().trim();
    const numBalance = typeof loveBalance === 'number' ? loveBalance : parseFloat(loveBalance);

    let user = memoryUsers.get(cleanEmail);
    if (!user && mongoose.connection.readyState === 1) {
      try {
        user = await UserModel.findOne({ email: cleanEmail }).lean();
      } catch (err) {}
    }
    const isDora = cleanEmail === 'arthurs10pc@gmail.com' ? false : (
      Boolean(user?.isDora) || 
      (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === cleanEmail)
    );

    if (!user) {
      const namePart = cleanEmail.split('@')[0];
      const capName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
      user = {
        email: cleanEmail,
        name: capName,
        firstName: capName,
        fullName: cleanEmail,
        role: cleanEmail === 'arthurs10pc@gmail.com' ? 'parent' : 'user',
        isAdmin: cleanEmail === 'arthurs10pc@gmail.com',
        isDora,
        loveBalance: isNaN(numBalance) ? 0 : numBalance,
        loveLedger: Array.isArray(loveLedger) ? sanitizeLedger(loveLedger) : [],
        lastLogin: new Date()
      };
    } else {
      user.isDora = isDora;
      if (!isNaN(numBalance)) user.loveBalance = numBalance;
      if (Array.isArray(loveLedger) && loveLedger.length > 0) {
        user.loveLedger = sanitizeLedger([...loveLedger, ...(user.loveLedger || [])]);
      }
      user.lastLogin = new Date();
    }
    memoryUsers.set(cleanEmail, user);

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { email: cleanEmail },
          {
            $set: {
              isDora: user.isDora,
              loveBalance: user.loveBalance,
              loveLedger: user.loveLedger,
              lastLogin: new Date()
            }
          },
          { upsert: true, new: true }
        );
      } catch (e) {}
    }

    const isActiveDora = user.isDora || (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail === cleanEmail);
    if (isActiveDora && !isNaN(numBalance)) {
      globalLoveBalanceState.activeDoraEmail = cleanEmail;
      globalLoveBalanceState.loveBalance = user.loveBalance;
      if (Array.isArray(user.loveLedger) && user.loveLedger.length > 0) {
        const adminTxs = (globalLoveBalanceState.loveLedger || []).filter(e => e && (e.target === 'admin' || (e.description && e.description.includes('[Darsh]'))));
        globalLoveBalanceState.loveLedger = sanitizeLedger([...user.loveLedger, ...adminTxs]);
      }
      persistLoveState();

      io.emit('love_balance_broadcast', {
        action: 'SYNC_STATE_RESPONSE',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests || []
      });
    }

    broadcastUsersDirectory();
    return res.json({
      success: true,
      loveBalance: user.loveBalance,
      isDora: Boolean(user.isDora),
      activeDoraEmail: globalLoveBalanceState.activeDoraEmail
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/set-dora', async (req, res) => {
  try {
    const { email, isDora, adminEmail } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'arthurs10pc@gmail.com') {
      return res.status(400).json({ error: 'Admin cannot be set as Dora' });
    }

    const result = await switchActiveDora(cleanEmail, isDora, adminEmail || 'arthurs10pc@gmail.com');
    return res.json({ success: true, email: cleanEmail, isDora: Boolean(isDora), ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/clear-ledger', async (req, res) => {
  try {
    const { target = 'both', adminEmail } = req.body || {};
    const nowTs = Date.now();
    if (target === 'user') {
      globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(item => item && (item.target === 'admin' || (item.description && item.description.includes('[Darsh]'))));
      globalLoveBalanceState.userLastClearedAt = nowTs;
    } else if (target === 'admin') {
      globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(item => item && item.target !== 'admin' && !(item.description && item.description.includes('[Darsh]')));
      globalLoveBalanceState.adminLastClearedAt = nowTs;
    } else {
      globalLoveBalanceState.loveLedger = [];
      globalLoveBalanceState.lastClearedAt = nowTs;
      globalLoveBalanceState.userLastClearedAt = nowTs;
      globalLoveBalanceState.adminLastClearedAt = nowTs;
    }
    globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
    globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
    persistLoveState();
    syncActiveDoraUserBalance();

    const payload = {
      action: 'CLEAR_LEDGER',
      target,
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      serverTimestamp: nowTs
    };
    io.emit('love_balance_action', payload);
    io.emit('love_balance_broadcast', payload);
    io.emit('love_balance_heartbeat_sync', {
      activeDoraEmail: globalLoveBalanceState.activeDoraEmail || '',
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      serverTimestamp: nowTs
    });
    return res.json({ success: true, ...payload });
  } catch (err) {
    console.error('clear-ledger error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'arthurs10pc@gmail.com') {
      return res.status(400).json({ error: 'Cannot delete primary Admin account' });
    }

    // 1. Remove from in-memory maps
    memoryUsers.delete(cleanEmail);
    for (const [sId, info] of activeRoomUsers.entries()) {
      if (info.email && info.email.toLowerCase() === cleanEmail) {
        activeRoomUsers.delete(sId);
      }
    }

    // 2. Permanently delete from MongoDB
    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.deleteMany({ email: cleanEmail });
      } catch (err) {
        console.warn('Mongo delete user error:', err.message);
      }
    }

    // 3. Reset active Dora if this deleted account was the active Dora
    if (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === cleanEmail) {
      globalLoveBalanceState.activeDoraEmail = '';
      globalLoveBalanceState.loveBalance = 0;
      persistLoveState();
    }

    // 4. Broadcast updated directory
    await broadcastUsersDirectory();
    io.emit('user_permanently_deleted', { email: cleanEmail, timestamp: Date.now() });

    return res.json({ success: true, deletedEmail: cleanEmail });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/users-directory', async (req, res) => {
  try {
    evaluateRoutineAndHabitInfractions();
    const directory = await getUsersDirectoryData();
    return res.json({ success: true, ...directory });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/love-balance/evaluate', (req, res) => {
  try {
    evaluateRoutineAndHabitInfractions();
    return res.json({
      success: true,
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/daily-tasks/sync', async (req, res) => {
  try {
    evaluateRoutineAndHabitInfractions();
    const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
    let slots = [...memoryDailySlots];
    if (mongoose.connection.readyState === 1) {
      const dbSlots = await DailyTaskSlot.find({ id: { $nin: activeDeleted } }).sort({ order: 1, createdAt: 1 }).lean();
      if (dbSlots && dbSlots.length > 0) {
        slots = dbSlots;
        memoryDailySlots = dbSlots;
      }
    }
    const cleanSlots = sortSlotsByTime(slots.filter(s => s && !activeDeleted.includes(s.id)));

    let submissions = memoryDailySubmissions;
    if (mongoose.connection.readyState === 1) {
      const past30Days = new Date(Date.now() - 30 * 86400000);
      submissions = await DailyTaskSubmission.find({ createdAt: { $gte: past30Days } }).lean();
      if (submissions && submissions.length > 0) {
        memoryDailySubmissions = submissions;
      }
    }
    return res.json({
      success: true,
      slots: cleanSlots,
      submissions,
      deletedSlotIds: activeDeleted
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/daily-tasks/slots/save', async (req, res) => {
  try {
    const slot = req.body;
    if (!slot || !slot.id) return res.status(400).json({ error: 'Valid slot required' });

    // Un-delete if previously deleted
    globalLoveBalanceState.deletedSlotIds = (globalLoveBalanceState.deletedSlotIds || []).filter(id => id !== slot.id);

    const existingIdx = memoryDailySlots.findIndex(s => s.id === slot.id);
    if (existingIdx >= 0) {
      memoryDailySlots[existingIdx] = { ...memoryDailySlots[existingIdx], ...slot };
    } else {
      memoryDailySlots.push(slot);
    }
    globalLoveBalanceState.dailySlots = memoryDailySlots;
    persistLoveState();

    if (mongoose.connection.readyState === 1) {
      await DailyTaskSlot.findOneAndUpdate(
        { id: slot.id },
        slot,
        { upsert: true, new: true }
      ).catch(() => {});
    }

    // Immediately evaluate routine infractions (in case deadline has passed)
    evaluateRoutineAndHabitInfractions();

    // Broadcast to all clients (both Admin and Dora)
    io.emit('daily_slots_updated', {
      slots: memoryDailySlots,
      deletedSlotIds: globalLoveBalanceState.deletedSlotIds
    });
    io.emit('love_balance_broadcast', {
      action: 'SYNC_STATE_RESPONSE',
      loveBalance: globalLoveBalanceState.loveBalance,
      adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      currentLoveBalance: globalLoveBalanceState.loveBalance,
      currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
      loveLedger: globalLoveBalanceState.loveLedger,
      wishRequests: globalLoveBalanceState.wishRequests,
      dailySubmissions: memoryDailySubmissions,
      dailySlots: memoryDailySlots,
      deletedSlotIds: globalLoveBalanceState.deletedSlotIds
    });

    return res.json({
      success: true,
      slot,
      slots: memoryDailySlots,
      loveBalance: globalLoveBalanceState.loveBalance
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/daily-tasks/slots/delete', async (req, res) => {
  try {
    const { slotId, deletedSlotIds } = req.body || {};
    if (!slotId) return res.status(400).json({ error: 'slotId required' });
    const allDeleted = Array.from(new Set([
      ...(globalLoveBalanceState.deletedSlotIds || []),
      slotId,
      ...(Array.isArray(deletedSlotIds) ? deletedSlotIds : [])
    ]));
    globalLoveBalanceState.deletedSlotIds = allDeleted;
    memoryDailySlots = memoryDailySlots.filter(s => s && !allDeleted.includes(s.id));
    globalLoveBalanceState.dailySlots = memoryDailySlots;
    persistLoveState();
    if (mongoose.connection.readyState === 1) {
      await DailyTaskSlot.deleteMany({ id: { $in: allDeleted } }).catch(() => {});
      await DailyTaskSlot.deleteOne({ id: slotId }).catch(() => {});
    }
    io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: allDeleted });
    io.emit('love_balance_broadcast', {
      action: 'DAILY_SLOT_DELETE',
      slotId,
      deletedSlotIds: allDeleted,
      dailySlots: memoryDailySlots
    });
    io.emit('togepi_movie_chat', {
      room: GLOBAL_ROOM,
      senderRole: 'parent',
      text: `__SLOT_DELETE__:${JSON.stringify({ slotId, deletedSlotIds: allDeleted })}`
    });
    return res.json({ success: true, slotId, deletedSlotIds: allDeleted, slots: memoryDailySlots });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// --- REAL-TIME USER PRESENCE TRACKING ---
const activeRoomUsers = new Map(); // socket.id -> { room, role, email, name, picture, isForeground: true, lastHeartbeat: timestamp }

async function getUsersDirectoryData() {
  const map = new Map();
  // 1. Load memory users
  memoryUsers.forEach((u, k) => {
    if (k && k.toLowerCase() !== 'dora@gmail.com') {
      map.set(k.toLowerCase(), { ...u });
    }
  });

  // 2. Load Mongo users if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const dbUsers = await UserModel.find({ email: { $ne: 'dora@gmail.com' } }).lean();
      dbUsers.forEach(u => {
        if (u && u.email && u.email.toLowerCase() !== 'dora@gmail.com') {
          const k = u.email.toLowerCase();
          map.set(k, { ...map.get(k), ...u, email: k });
        }
      });
    } catch (e) {}
  }

  // Demo account 'dora@gmail.com' must never be listed
  map.delete('dora@gmail.com');

  // 3. Compute live presence
  const now = Date.now();
  const list = Array.from(map.values())
    .filter(u => u && u.email && u.email.toLowerCase() !== 'dora@gmail.com')
    .map(u => {
    let isOnline = false;
    let connectedCount = 0;
    for (const [sId, info] of activeRoomUsers.entries()) {
      if ((now - (info.lastHeartbeat || now)) < 30000) {
        if (info.email && info.email.toLowerCase() === u.email.toLowerCase()) {
          isOnline = true;
          connectedCount++;
        } else if (!info.email && info.role === u.role) {
          isOnline = true;
          connectedCount++;
        }
      }
    }
    const isAdmin = u.email.toLowerCase() === 'arthurs10pc@gmail.com';
    const isDora = isAdmin ? false : (Boolean(u.isDora) || (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === u.email.toLowerCase()));
    return {
      email: u.email,
      name: u.name || (isAdmin ? 'Darsh' : (u.firstName || 'User')),
      firstName: u.firstName || (isAdmin ? 'Darsh' : 'User'),
      fullName: u.fullName || u.originalName || u.name || '',
      originalName: u.originalName || u.name || '',
      role: isAdmin ? 'parent' : 'user',
      isAdmin,
      isDora,
      loveBalance: isDora 
        ? (typeof globalLoveBalanceState.loveBalance === 'number' ? globalLoveBalanceState.loveBalance : 0)
        : (typeof u.loveBalance === 'number' ? u.loveBalance : 0),
      picture: u.picture || '',
      isOnline,
      connectedSessions: connectedCount,
      lastLogin: u.lastLogin || new Date()
    };
  });

  // Sort: online first, then Admin, then Dora, then latest login
  list.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return b.isOnline ? 1 : -1;
    if (a.isAdmin !== b.isAdmin) return b.isAdmin ? 1 : -1;
    if (a.isDora !== b.isDora) return b.isDora ? 1 : -1;
    return new Date(b.lastLogin).getTime() - new Date(a.lastLogin).getTime();
  });

  return {
    totalCount: list.length,
    onlineCount: list.filter(u => u.isOnline).length,
    users: list
  };
}

async function broadcastUsersDirectory() {
  try {
    const data = await getUsersDirectoryData();
    io.emit('users_directory_update', data);
  } catch (e) {
    console.warn("broadcastUsersDirectory error:", e.message);
  }
}

function broadcastPresence(room) {
  const targetRoom = room || 'stealth_master_room';
  const onlineRoles = new Set();
  const onlineEmails = new Set();
  const now = Date.now();
  for (const [sId, info] of activeRoomUsers.entries()) {
    const liveSocket = io.sockets.sockets.get(sId);
    const isLive = liveSocket && liveSocket.connected;
    if (isLive || (now - (info.lastHeartbeat || now)) < 60000) {
      if (info.role) onlineRoles.add(info.role);
      if (info.email) onlineEmails.add(info.email);
    }
  }
  const payload = {
    onlineRoles: Array.from(onlineRoles),
    onlineEmails: Array.from(onlineEmails),
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
    const currentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const currentHour = istNow.getUTCHours();

    const parseSlotEndMinutes = (slot) => {
      if (!slot) return null;
      const timeRange = slot.timeRange;
      if (!timeRange || typeof timeRange !== 'string') return null;
      const parts = timeRange.split('-').map(p => p.trim());
      if (parts.length < 2) return null;
      const timePart = parts[1];
      const colonIdx = timePart.indexOf(':');
      if (colonIdx === -1) return null;
      let h = parseInt(timePart.slice(0, colonIdx), 10);
      let m = parseInt(timePart.slice(colonIdx + 1, colonIdx + 3) || '0', 10);
      if (isNaN(h)) return null;
      const tag = (slot.tag || '').toLowerCase();
      // PM slots in daily routine (Lunch, Water, Tea, Dinner, Steps, Skincare)
      if (['lunch', 'water', 'tea', 'dinner', 'steps', 'skincare'].includes(tag) && h < 12) {
        h += 12;
      } else if (h >= 1 && h <= 7) {
        h += 12; // 01:00 PM to 07:00 PM
      }
      return h * 60 + (isNaN(m) ? 0 : m);
    };

    const isMorningMsg = (text) => {
      if (!text || typeof text !== 'string') return false;
      const lower = text.toLowerCase();
      return lower.includes('good morning') || lower.includes('morning') || lower.includes('gm') || 
             lower.includes('gud mrng') || lower.includes('suprabhat') || lower.includes('subah') ||
             lower.includes('goodmrng') || lower.includes('mrg') || lower.includes('uth jao');
    };

    const isGoodNightMsg = (text) => {
      if (!text || typeof text !== 'string') return false;
      const lower = text.toLowerCase();
      return lower.includes('good night') || lower.includes('goodnight') || lower.includes('gn') || 
             lower.includes('gud nite') || lower.includes('sweet dreams') || lower.includes('shubh ratri') || 
             lower.includes('sleep tight') || lower.includes('so jao') || lower.includes('sleep well') ||
             lower.includes('gnight') || lower.includes('night') || lower.includes('shubhratri');
    };

    const lastCleared = globalLoveBalanceState.lastClearedAt || 0;
    const userEffectiveClearTime = Math.max(lastCleared, globalLoveBalanceState.userLastClearedAt || 0);
    const adminEffectiveClearTime = Math.max(lastCleared, globalLoveBalanceState.adminLastClearedAt || 0);
    const clearedDateStr = userEffectiveClearTime > 0 ? new Date(userEffectiveClearTime + istOffset).toISOString().split('T')[0] : '';
    const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
    const activeSlots = (memoryDailySlots || []).filter(s => s && s.isActive && !(globalLoveBalanceState.deletedSlotIds || []).includes(s.id));
    let ledgerChanged = false;

    const msgs = Array.isArray(memoryMessages) ? memoryMessages : [];

    const hasEntry = (id, target, dateStr, exactSlotId, type) => {
      if (delTxs.includes(id)) return true;
      return (globalLoveBalanceState.loveLedger || []).some(e => {
        if (!e) return false;
        if (e.id === id) return true;
        if (target && e.target !== target) return false;
        if (type && e.type !== type) return false;
        if (exactSlotId) {
          if (e.id && (e.id === `habit_routine_${exactSlotId}_${dateStr}_${target}` || e.id === `habit_routine_${exactSlotId}_${dateStr}_user`)) return true;
        }
        return false;
      });
    };

    const addHabitEntry = (id, target, type, amount, description, remarks, dateStr, exactSlotId, explicitTime) => {
      if (hasEntry(id, target, dateStr, exactSlotId, type)) return;
      const targetLabel = target === 'user' ? 'Dora' : 'Darsh';
      const timePart = explicitTime || '10:00 am';
      const newEntry = {
        id,
        sl: 1,
        target,
        description: `[${targetLabel}] ${description}`,
        earnedAt: `${dateStr}, ${timePart}`,
        expireDate: '',
        points: type === 'credit' ? Math.abs(amount) : -Math.abs(amount),
        type,
        remarks,
        status: type === 'credit' ? 'Confirmed' : 'Deducted'
      };
      globalLoveBalanceState.loveLedger = [newEntry, ...(globalLoveBalanceState.loveLedger || [])];
      ledgerChanged = true;
    };

    // Evaluate routine and habits for today and yesterday (preventing retroactive deduction of past 30 days)
    for (let i = 1; i >= 0; i--) {
      const d = new Date(istNow.getTime() - i * 86400000);
      const dayStr = d.toISOString().split('T')[0];
      if (dayStr < SYSTEM_START_DATE) continue;
      if (clearedDateStr && dayStr < clearedDateStr) continue;

      const nextDayStr = new Date(d.getTime() + 86400000).toISOString().split('T')[0];
      const isPastDay = dayStr < todayStr;
      const isToday = dayStr === todayStr;

      // 1. MORNING GREETING (5:00 AM - 9:00 AM)
      if (isPastDay || (isToday && currentHour >= 9)) {
        const morningDeadlineMs = new Date(`${dayStr}T09:00:00+05:30`).getTime();

        // Dora morning check (only if deadline is after clear timestamp)
        if (!(userEffectiveClearTime > 0 && morningDeadlineMs <= userEffectiveClearTime)) {
          const doraMId = `habit_morning_${dayStr}_user`;
          const hadDoraMorning = msgs.some(m => {
            if (!m || !m.timestamp) return false;
            const mIst = new Date(new Date(m.timestamp).getTime() + istOffset);
            const mDate = mIst.toISOString().split('T')[0];
            const mHour = mIst.getUTCHours();
            const isDora = m.senderRole === 'user' || m.senderRole === 'A';
            return isDora && mDate === dayStr && mHour >= 5 && mHour < 9 && isMorningMsg(m.text || '');
          });
          if (hadDoraMorning) {
            if (!hasEntry(doraMId, 'user', dayStr, 'Morning', 'credit')) {
              addHabitEntry(doraMId, 'user', 'credit', 2.00, `Daily Morning Sweet Text (${dayStr})`, 'Daily Morning Sweet Greeting', dayStr, 'Morning', '09:00 am');
            }
          } else {
            if (!hasEntry(doraMId, 'user', dayStr, 'Morning', 'debit')) {
              addHabitEntry(doraMId, 'user', 'debit', 2.00, `Missed Morning Greeting (${dayStr})`, 'Missed Morning Greeting Before 9:00 AM', dayStr, 'Morning', '09:00 am');
            }
          }
        }

        // Darsh morning check (only if deadline is after clear timestamp)
        if (!(adminEffectiveClearTime > 0 && morningDeadlineMs <= adminEffectiveClearTime)) {
          const darshMId = `habit_morning_${dayStr}_admin`;
          const hadDarshMorning = msgs.some(m => {
            if (!m || !m.timestamp) return false;
            const mIst = new Date(new Date(m.timestamp).getTime() + istOffset);
            const mDate = mIst.toISOString().split('T')[0];
            const mHour = mIst.getUTCHours();
            const isDarsh = m.senderRole === 'parent' || m.senderRole === 'admin' || m.senderRole === 'H';
            return isDarsh && mDate === dayStr && mHour >= 5 && mHour < 9 && isMorningMsg(m.text || '');
          });
          if (hadDarshMorning) {
            if (!hasEntry(darshMId, 'admin', dayStr, 'Morning', 'credit')) {
              addHabitEntry(darshMId, 'admin', 'credit', 2.00, `Daily Morning Sweet Text (${dayStr})`, 'Daily Morning Sweet Greeting', dayStr, 'Morning', '09:00 am');
            }
          }
        }
      }

      // 2. GOOD NIGHT (8:00 PM - 5:00 AM next morning)
      if (isPastDay) {
        const nightDeadlineMs = new Date(`${nextDayStr}T05:00:00+05:30`).getTime();

        // Dora night check (only if deadline is after clear timestamp)
        if (!(userEffectiveClearTime > 0 && nightDeadlineMs <= userEffectiveClearTime)) {
          const doraNId = `habit_night_${dayStr}_user`;
          const hadDoraNight = msgs.some(m => {
            if (!m || !m.timestamp) return false;
            const mIst = new Date(new Date(m.timestamp).getTime() + istOffset);
            const mDate = mIst.toISOString().split('T')[0];
            const mHour = mIst.getUTCHours();
            const isDora = m.senderRole === 'user' || m.senderRole === 'A';
            const eve = mDate === dayStr && mHour >= 20;
            const wee = mDate === nextDayStr && mHour < 5;
            return isDora && (eve || wee) && isGoodNightMsg(m.text || '');
          });
          if (hadDoraNight) {
            if (!hasEntry(doraNId, 'user', dayStr, 'Good Night', 'credit')) {
              addHabitEntry(doraNId, 'user', 'credit', 2.00, `Sweet Good Night Wish (${dayStr})`, 'Sweet Good Night Wish', dayStr, 'Good Night', '11:00 pm');
            }
          } else {
            if (!hasEntry(doraNId, 'user', dayStr, 'Good Night', 'debit')) {
              addHabitEntry(doraNId, 'user', 'debit', 3.00, `Sleeping Without "Good Night" (${dayStr})`, 'Sleeping Without "Good Night"', dayStr, 'Good Night', '11:00 pm');
            }
          }
        }

        // Darsh night check (only if deadline is after clear timestamp)
        if (!(adminEffectiveClearTime > 0 && nightDeadlineMs <= adminEffectiveClearTime)) {
          const darshNId = `habit_night_${dayStr}_admin`;
          const hadDarshNight = msgs.some(m => {
            if (!m || !m.timestamp) return false;
            const mIst = new Date(new Date(m.timestamp).getTime() + istOffset);
            const mDate = mIst.toISOString().split('T')[0];
            const mHour = mIst.getUTCHours();
            const isDarsh = m.senderRole === 'parent' || m.senderRole === 'admin' || m.senderRole === 'H';
            const eve = mDate === dayStr && mHour >= 20;
            const wee = mDate === nextDayStr && mHour < 5;
            return isDarsh && (eve || wee) && isGoodNightMsg(m.text || '');
          });
          if (hadDarshNight) {
            if (!hasEntry(darshNId, 'admin', dayStr, 'Good Night', 'credit')) {
              addHabitEntry(darshNId, 'admin', 'credit', 2.00, `Sweet Good Night Wish (${dayStr})`, 'Sweet Good Night Wish', dayStr, 'Good Night', '11:00 pm');
            }
          }
        }
      }

      // 3. DAILY ROUTINE TASKS (AUTOMATIC MISSED SLOT DEDUCTIONS)
      activeSlots.forEach(slot => {
        const slotEndMinutes = parseSlotEndMinutes(slot);
        const isOverdue = isPastDay || (isToday && slotEndMinutes !== null && currentMinutes > slotEndMinutes);
        if (!isOverdue) return;

        // If the slot deadline expired before or at the clear timestamp, DO NOT deduct!
        if (slotEndMinutes !== null) {
          const endH = Math.floor(slotEndMinutes / 60);
          const endM = slotEndMinutes % 60;
          const slotDeadlineMs = new Date(`${dayStr}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00+05:30`).getTime();
          if (userEffectiveClearTime > 0 && slotDeadlineMs <= userEffectiveClearTime) {
            return;
          }
        }

        const slotTxId = `habit_routine_${slot.id}_${dayStr}_user`;
        const sub = (memoryDailySubmissions || []).find(s => s && s.slotId === slot.id && s.date === dayStr);

        if (sub && sub.status === 'APPROVED') {
          // If already approved, cancel/remove any previously added missed debit penalty
          const existingDebitIdx = (globalLoveBalanceState.loveLedger || []).findIndex(e => e && e.id === slotTxId);
          if (existingDebitIdx >= 0) {
            globalLoveBalanceState.loveLedger.splice(existingDebitIdx, 1);
            ledgerChanged = true;
          }
        } else if (sub && sub.status === 'PENDING' && (Boolean(sub.image) || Boolean(sub.note))) {
          // Under review: do not penalize while awaiting review
          const existingDebitIdx = (globalLoveBalanceState.loveLedger || []).findIndex(e => e && e.id === slotTxId);
          if (existingDebitIdx >= 0) {
            globalLoveBalanceState.loveLedger.splice(existingDebitIdx, 1);
            ledgerChanged = true;
          }
        } else {
          // Not submitted or rejected: DEDUCT MISSED ROUTINE TASK POINTS
          if (!hasEntry(slotTxId, 'user', dayStr, slot.id, 'debit')) {
            const penaltyPts = Math.abs(Number(slot.rewardPoints) || 2.0);
            addHabitEntry(
              slotTxId,
              'user',
              'debit',
              penaltyPts,
              `Missed Routine Task: ${slot.title} (${dayStr})`,
              `Missed Routine Task Deadline (${slot.timeRange})`,
              dayStr,
              slot.id,
              slot.timeRange || '10:30 am'
            );
          }
        }
      });
    }

    // 4. ENSURE ALL APPROVED ROUTINE TASKS ARE CREDITED TO DORA
    (memoryDailySubmissions || []).forEach(sub => {
      if (sub && sub.status === 'APPROVED' && (sub.pointsAwarded > 0 || sub.points > 0)) {
        const pts = parseFloat(sub.pointsAwarded || sub.points || 2.0);
        const subDate = sub.date || todayStr;
        if (clearedDateStr && subDate < clearedDateStr) return;
        const subTime = sub.reviewedAt ? new Date(sub.reviewedAt).getTime() : (sub.submittedAt ? new Date(sub.submittedAt).getTime() : 0);
        if (userEffectiveClearTime > 0 && subTime > 0 && subTime <= userEffectiveClearTime) return;
        const approvalEntryId = 'lb_appr_' + (sub.id || `${subDate}_${sub.slotId}`);
        if (delTxs.includes(approvalEntryId)) return;
        const alreadyAwarded = (globalLoveBalanceState.loveLedger || []).some(e => e && e.id === approvalEntryId);
        if (!alreadyAwarded) {
          const slot = (memoryDailySlots || []).find(s => s && s.id === sub.slotId);
          const taskName = sub.slotTitle || (slot ? slot.title : 'Routine Task');
          let earnedAtTime = '12:00 pm';
          if (sub.reviewedAt || sub.submittedAt) {
            try {
              const dt = new Date(sub.reviewedAt || sub.submittedAt);
              earnedAtTime = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase();
            } catch (e) {}
          } else if (slot && slot.timeRange) {
            earnedAtTime = slot.timeRange.split('-')[0].trim();
          }
          const entry = {
            id: approvalEntryId,
            sl: 1,
            target: 'user',
            description: `[Dora] Approved Task: ${taskName}`,
            earnedAt: `${subDate}, ${earnedAtTime}`,
            expireDate: '',
            points: pts,
            type: 'credit',
            remarks: `Approved Task: ${taskName}`,
            status: 'Confirmed'
          };
          globalLoveBalanceState.loveLedger = [entry, ...(globalLoveBalanceState.loveLedger || [])];
          ledgerChanged = true;
        }
      }
    });

    if (ledgerChanged) {
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
      syncActiveDoraUserBalance();
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
      io.emit('love_balance_heartbeat_sync', {
        activeDoraEmail: globalLoveBalanceState.activeDoraEmail || '',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests,
        dailySubmissions: memoryDailySubmissions,
        dailySlots: activeSlots,
        deletedSlotIds: globalLoveBalanceState.deletedSlotIds || [],
        deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || []
      });
      broadcastUsersDirectory();
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
    const liveSocket = io.sockets.sockets.get(sId);
    if (!liveSocket || !liveSocket.connected) {
      if (now - (info.lastHeartbeat || now) > 60000) {
        activeRoomUsers.delete(sId);
        changed = true;
      }
    } else {
      info.lastHeartbeat = now;
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
  // Ensure ledger is clean and mathematical totals reflect reality
  globalLoveBalanceState.loveLedger = sanitizeLedger(globalLoveBalanceState.loveLedger);
  globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
  globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');

  const mapSlots = new Map();
  DEFAULT_DAILY_SLOTS.filter(d => !activeDeleted.includes(d.id)).forEach(d => mapSlots.set(d.id, d));
  (memoryDailySlots || []).filter(s => s && s.id && !activeDeleted.includes(s.id)).forEach(s => mapSlots.set(s.id, s));
  const broadcastSlots = sortSlotsByTime(Array.from(mapSlots.values()));
  memoryDailySlots = broadcastSlots;

  io.emit('love_balance_heartbeat_sync', {
    activeDoraEmail: (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail !== 'dora@gmail.com') ? globalLoveBalanceState.activeDoraEmail : '',
    loveBalance: globalLoveBalanceState.loveBalance,
    adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    currentLoveBalance: globalLoveBalanceState.loveBalance,
    currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
    loveLedger: globalLoveBalanceState.loveLedger,
    wishRequests: globalLoveBalanceState.wishRequests,
    dailySubmissions: memoryDailySubmissions,
    dailySlots: broadcastSlots,
    deletedSlotIds: activeDeleted,
    deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
    lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
    serverTimestamp: Date.now()
  });
}, 4000);

const globalCoupleGamesState = {
  tictactoe: {
    board: Array(9).fill(null),
    turn: 'H',
    betAmount: 2.0,
    scores: { H: 0, A: 0 },
    gameStatus: 'PLAYING',
    winner: null,
    isDraw: false,
    lastActionAt: Date.now()
  },
  ludo: {
    tokens: { H: [-1, -1, -1, -1], A: [-1, -1, -1, -1] },
    turn: 'H',
    dice: 6,
    statusMsg: 'Game ready! Darsh rolls first.',
    scores: { H: 0, A: 0 },
    betAmount: 2.0,
    winner: null,
    lastActionAt: Date.now()
  },
  activeChallenge: null
};

// --- UNIFIED ULTRA-RELIABLE STEALTH MESSAGE PROCESSOR (SOCKET + HTTP REST DUAL-PATH) ---
async function processStealthMessage(data) {
  const { room, role, encryptedText, isMedia, replyRefId, clientMsgId } = data || {};
  if (!encryptedText) return null;

  io.emit('peer_typing_status', { isTyping: false });

  // 1. Deduplication by clientMsgId
  if (clientMsgId && memoryMessages.some(m => m.clientMsgId && m.clientMsgId === clientMsgId)) {
    return memoryMessages.find(m => m.clientMsgId === clientMsgId);
  }

  const plainText = decryptText(encryptedText);
  const msgTimestamp = new Date();

  // 2. Deduplication of identical payload within 1.5s
  const recentDuplicate = memoryMessages.find(m => 
    m.senderRole === role && 
    m.encryptedText === encryptedText && 
    (Date.now() - new Date(m.timestamp).getTime()) < 1500
  );
  if (recentDuplicate) {
    return recentDuplicate;
  }

  const counterpartRole = (role === 'user' || role === 'A') ? 'parent' : 'user';
  let isCounterpartOnline = false;
  for (const [sId, info] of activeRoomUsers.entries()) {
    const liveSocket = io.sockets.sockets.get(sId);
    const isLive = liveSocket && liveSocket.connected;
    if (isLive && info && (info.role === counterpartRole || (counterpartRole === 'parent' && info.role === 'admin'))) {
      isCounterpartOnline = true;
      break;
    }
  }

  const newMsgData = {
    _id: new mongoose.Types.ObjectId().toString(),
    clientMsgId: clientMsgId || null,
    room: room || 'stealth_master_room',
    senderRole: role,
    encryptedText,
    text: plainText,
    timestamp: msgTimestamp,
    flaggedPending: false,
    isSeen: false,
    isDelivered: isCounterpartOnline,
    isMedia: Boolean(isMedia),
    mediaType: data.mediaType || (Boolean(isMedia) ? 'photo' : 'text'),
    mediaOpened: false,
    reaction: null,
    isPinned: Boolean(data.isPinned),
    isStarred: Boolean(data.isStarred),
    replyRefId: replyRefId || null
  };

  // Always push to in-memory messages for instant real-time parity
  memoryMessages.push(newMsgData);

  const targetRoom = room || 'stealth_master_room';
  io.to(targetRoom).emit('receive_stealth_msg', newMsgData);
  io.emit('receive_stealth_msg', newMsgData);

  try {
    if (mongoose.connection.readyState === 1) {
      Message.create(newMsgData).catch(console.error);
    }
  } catch (err) {
    console.error("Error saving message:", err);
  }

  // Real-time server-side message karma evaluation (2-way for Dora & Darsh)
  try {
    const isSenderDora = (role === 'user' || role === 'A');
    const targetUser = isSenderDora ? 'user' : 'admin';
    const targetLabel = isSenderDora ? 'Dora' : 'Darsh';

    const priorMsgs = memoryMessages.filter(m => 
      m && m.room === (room || 'stealth_master_room') && 
      m._id !== newMsgData._id &&
      (isSenderDora 
        ? (m.senderRole === 'parent' || m.senderRole === 'admin' || m.senderRole === 'H')
        : (m.senderRole === 'user' || m.senderRole === 'A')) &&
      m.timestamp
    );
    const lastCounterpartMsg = priorMsgs.length > 0 ? priorMsgs[priorMsgs.length - 1] : null;

    if (lastCounterpartMsg && lastCounterpartMsg.timestamp) {
      const diffMs = Math.abs(msgTimestamp.getTime() - new Date(lastCounterpartMsg.timestamp).getTime());
      if (diffMs <= 30 * 1000) {
        if (!globalLoveBalanceState.rewardedTurnMsgIds) {
          globalLoveBalanceState.rewardedTurnMsgIds = [];
        }
        const turnKey = `${lastCounterpartMsg._id}_${targetUser}`;
        if (!globalLoveBalanceState.rewardedTurnMsgIds.includes(turnKey)) {
          if (!globalLoveBalanceState.lastInstantReplyTime) {
            globalLoveBalanceState.lastInstantReplyTime = {};
          }
          const lastInstantMs = globalLoveBalanceState.lastInstantReplyTime[targetUser] || 0;
          const FIVE_MIN_MS = 5 * 60 * 1000;
          const hasRecentInLedger = (globalLoveBalanceState.loveLedger || []).some(e => {
            if (!e || !e.description || !e.description.includes('Instant Reply')) return false;
            const isTarget = targetUser === 'admin'
              ? (e.target === 'admin' || (e.description && e.description.includes('[Darsh]')))
              : (e.target === 'user' || !(e.description && e.description.includes('[Darsh]')));
            if (!isTarget) return false;
            let txMs = 0;
            const parts = (e.id || '').split('_');
            if (parts.length >= 3 && parts[0] === 'lb' && parts[1] === 'instant') {
              txMs = Number(parts[2]);
            } else if (parts.length >= 2 && parts[0] === 'lb') {
              txMs = Number(parts[1]);
            }
            if (isNaN(txMs) || txMs === 0) {
              try { txMs = new Date(e.earnedAt).getTime(); } catch(err) {}
            }
            return txMs > 0 && Math.abs(Date.now() - txMs) < FIVE_MIN_MS;
          });

          if ((Date.now() - lastInstantMs >= FIVE_MIN_MS) && !hasRecentInLedger) {
            globalLoveBalanceState.lastInstantReplyTime[targetUser] = Date.now();
            globalLoveBalanceState.rewardedTurnMsgIds.push(turnKey);
            if (globalLoveBalanceState.rewardedTurnMsgIds.length > 500) {
              globalLoveBalanceState.rewardedTurnMsgIds.shift();
            }

            const replyTxId = `lb_instant_${Date.now()}_${targetUser}`;
            const nowStr = getNowIstEarnedAt();
            const expDate = new Date();
            expDate.setMonth(expDate.getMonth() + 1);
            const expStr = expDate.toISOString().split('T')[0];

            const replyEntry = {
              id: replyTxId,
              sl: 1,
              target: targetUser,
              description: `[${targetLabel}] Instant Reply (Within 30 Sec)`,
              earnedAt: nowStr,
              expireDate: expStr,
              points: 0.50,
              type: 'credit',
              remarks: 'Instant Reply (Within 30 Sec)',
              status: 'Confirmed'
            };

            const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
            if (!delTxs.includes(replyTxId)) {
              globalLoveBalanceState.loveLedger = [replyEntry, ...(globalLoveBalanceState.loveLedger || [])];
              syncBalancesFromLedger();
              persistLoveState();
              syncActiveDoraUserBalance();

              io.emit('love_balance_broadcast', {
                action: 'TRANSACTION',
                target: targetUser,
                amount: 0.50,
                type: 'credit',
                reason: 'Instant Reply (Within 30 Sec)',
                newEntry: replyEntry,
                loveLedger: globalLoveBalanceState.loveLedger,
                currentLoveBalance: globalLoveBalanceState.loveBalance,
                currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
                serverTimestamp: Date.now()
              });

              io.emit('love_balance_heartbeat_sync', {
                activeDoraEmail: globalLoveBalanceState.activeDoraEmail || '',
                loveBalance: globalLoveBalanceState.loveBalance,
                adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
                currentLoveBalance: globalLoveBalanceState.loveBalance,
                currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
                loveLedger: globalLoveBalanceState.loveLedger,
                wishRequests: globalLoveBalanceState.wishRequests,
                dailySubmissions: memoryDailySubmissions,
                dailySlots: (memoryDailySlots || []).filter(s => s && !(globalLoveBalanceState.deletedSlotIds || []).includes(s.id)),
                deletedSlotIds: globalLoveBalanceState.deletedSlotIds || [],
                deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
                lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
                serverTimestamp: Date.now()
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("Error evaluating server instant reply rule:", e);
  }

  // Push Notification to counterpart mobile device
  try {
    const isSenderAdmin = (role === 'parent' || role === 'admin' || role === 'H');
    const senderName = isSenderAdmin ? 'Darsh' : 'Dora';
    const targetRole = isSenderAdmin ? 'user' : 'parent';
    const preview = isMedia ? '📷 Photo' : (plainText && plainText.length > 60 ? plainText.substring(0, 57) + '...' : (plainText || 'New message'));
    sendWebPushNotification({
      title: `ChatGPT • ${senderName}`,
      body: preview,
      targetRole,
      data: { type: 'chat' }
    });
  } catch (pushErr) {
    console.warn('[WebPush] Error sending chat push:', pushErr);
  }

  return newMsgData;
}

// Guaranteed REST message dispatch fallback endpoint
app.post('/api/stealth-messages/send', async (req, res) => {
  try {
    const msg = await processStealthMessage(req.body);
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error("REST send stealth message error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Guaranteed REST mark-seen fallback endpoint
app.post('/api/stealth-messages/mark-seen', async (req, res) => {
  try {
    const { room, viewerRole } = req.body || {};
    const targetRoom = room || 'stealth_master_room';
    const isDora = (viewerRole === 'user' || viewerRole === 'A');

    memoryMessages.forEach(m => {
      if (!room || m.room === targetRoom) {
        const isFromCounterpart = isDora 
          ? (m.senderRole === 'parent' || m.senderRole === 'admin' || m.senderRole === 'H')
          : (m.senderRole === 'user' || m.senderRole === 'A');
        if (isFromCounterpart) {
          m.isSeen = true;
          m.isDelivered = true;
        }
      }
    });

    io.to(targetRoom).emit('messages_marked_seen', { viewerRole });
    io.emit('messages_marked_seen', { viewerRole });

    if (mongoose.connection.readyState === 1) {
      const counterpartRoles = isDora ? ['parent', 'admin', 'H'] : ['user', 'A'];
      await Message.updateMany(
        { room: targetRoom, senderRole: { $in: counterpartRoles }, isSeen: false },
        { $set: { isSeen: true, isDelivered: true } }
      ).catch(console.error);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("REST mark seen error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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

    socket.emit('sync_restore_state', {
      connected: Boolean(globalSyncState.connected),
      videoId: globalSyncState.videoId || '',
      title: globalSyncState.title || '',
      state: globalSyncState.state || 'PAUSE',
      currentTime: getAccurateSyncTime(),
      timestamp: Date.now(),
      queue: globalSyncState.queue || [null, null, null]
    });

    // Always emit current upcoming song queue on connect
    socket.emit('sync_queue_broadcast', { queue: globalSyncState.queue || [null, null, null] });

    if (codexCinemaState.url || codexCinemaState.ytId || codexCinemaState.embedUrl || codexCinemaState.engine === 'local') {
      socket.emit('codex_restore_state', codexCinemaState);
    }

    // Sync Love Balance real-time state to newly connected client
    const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
    const mapSlots = new Map();
    DEFAULT_DAILY_SLOTS.filter(d => !activeDeleted.includes(d.id)).forEach(d => mapSlots.set(d.id, d));
    (memoryDailySlots || []).filter(s => s && s.id && !activeDeleted.includes(s.id)).forEach(s => mapSlots.set(s.id, s));
    const activeSlots = sortSlotsByTime(Array.from(mapSlots.values()));
    memoryDailySlots = activeSlots;

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
      let initialSubmissions = memoryDailySubmissions;
      if (mongoose.connection.readyState === 1) {
        const past30Days = new Date(Date.now() - 30 * 86400000);
        initialSubmissions = await DailyTaskSubmission.find({ createdAt: { $gte: past30Days } }).lean();
      }
      socket.emit('daily_task_sync_response', {
        date: todayStr,
        slots: activeSlots,
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

  // --- REAL-TIME COUPLE MINI-GAMES AUTHORITATIVE ENGINE (TIC-TAC-TOE & LUDO) ---
  const handleGameActionInternal = async (gameData) => {
    try {
      if (!gameData) return;
      const { type, gameId, betAmount, winner, isDraw, board, tokens, turn, dice, statusMsg, scores } = gameData;
      const targetGame = (gameId === 'ludo' || (!board && tokens)) ? 'ludo' : 'tictactoe';

      if (!globalCoupleGamesState[targetGame]) {
        globalCoupleGamesState[targetGame] = {};
      }
      if (board) globalCoupleGamesState[targetGame].board = board;
      if (tokens) globalCoupleGamesState[targetGame].tokens = tokens;
      if (turn) globalCoupleGamesState[targetGame].turn = turn;
      if (dice !== undefined) globalCoupleGamesState[targetGame].dice = dice;
      if (statusMsg) globalCoupleGamesState[targetGame].statusMsg = statusMsg;
      if (scores) globalCoupleGamesState[targetGame].scores = scores;
      if (betAmount !== undefined) globalCoupleGamesState[targetGame].betAmount = betAmount;
      if (winner !== undefined) globalCoupleGamesState[targetGame].winner = winner;
      if (isDraw !== undefined) globalCoupleGamesState[targetGame].isDraw = isDraw;

      if (type === 'RESET') {
        if (targetGame === 'tictactoe') {
          globalCoupleGamesState.tictactoe.board = Array(9).fill(null);
          globalCoupleGamesState.tictactoe.turn = 'H';
          globalCoupleGamesState.tictactoe.winner = null;
          globalCoupleGamesState.tictactoe.isDraw = false;
          globalCoupleGamesState.tictactoe.gameStatus = 'PLAYING';
        } else {
          globalCoupleGamesState.ludo.tokens = { H: [-1, -1, -1, -1], A: [-1, -1, -1, -1] };
          globalCoupleGamesState.ludo.turn = 'H';
          globalCoupleGamesState.ludo.dice = 6;
          globalCoupleGamesState.ludo.winner = null;
          globalCoupleGamesState.ludo.statusMsg = 'Match reset! Darsh rolls first.';
        }
      }
      globalCoupleGamesState[targetGame].lastActionAt = Date.now();
      
      if (type === 'MATCH_FINISH' && winner) {
        const bet = round2(betAmount || 0);
        const winnerTarget = winner === 'H' ? 'admin' : 'user';
        const loserTarget = winner === 'H' ? 'user' : 'admin';
        const winnerLabel = winner === 'H' ? 'Darsh' : 'Dora';
        const loserLabel = winner === 'H' ? 'Dora' : 'Darsh';
        const gameLabel = targetGame === 'ludo' ? 'Ludo Royale' : 'Couple Tic-Tac-Toe';

        if (bet > 0) {
          const winEntry = {
            id: `game_win_${Date.now()}_${winnerTarget}`,
            sl: 1,
            target: winnerTarget,
            description: `[${winnerLabel}] 🏆 Won ${gameLabel} vs ${loserLabel}`,
            earnedAt: getNowIstEarnedAt(),
            expireDate: '',
            points: bet,
            type: 'credit',
            remarks: `Won match pot (Bet: ₹${bet.toFixed(2)})`,
            status: 'Confirmed'
          };

          const loseEntry = {
            id: `game_lose_${Date.now()}_${loserTarget}`,
            sl: 1,
            target: loserTarget,
            description: `[${loserLabel}] 🎲 ${gameLabel} Match Bet`,
            earnedAt: getNowIstEarnedAt(),
            expireDate: '',
            points: -bet,
            type: 'debit',
            remarks: `Match bet lost to ${winnerLabel}`,
            status: 'Deducted'
          };

          globalLoveBalanceState.loveLedger = sanitizeLedger([winEntry, loseEntry, ...(globalLoveBalanceState.loveLedger || [])]);
          syncBalancesFromLedger();
          persistLoveState();
          syncActiveDoraUserBalance();

          io.emit('love_balance_broadcast', {
            action: 'TRANSACTION',
            loveLedger: globalLoveBalanceState.loveLedger,
            currentLoveBalance: globalLoveBalanceState.loveBalance,
            currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
            serverTimestamp: Date.now()
          });
        }
      }

      // Broadcast updated authoritative state to EVERY connected client on both channels!
      io.emit('couple_game_broadcast', {
        ...gameData,
        gameId: targetGame,
        state: globalCoupleGamesState[targetGame]
      });
      io.emit('arcade_game_action_broadcast', {
        ...gameData,
        gameId: targetGame,
        ...globalCoupleGamesState[targetGame]
      });
    } catch (err) {
      console.error('Error in handleGameActionInternal:', err);
    }
  };

  socket.on('arcade_game_action', handleGameActionInternal);
  socket.on('couple_game_action', handleGameActionInternal);

  socket.on('couple_game_get_state', ({ gameId }) => {
    const targetGame = gameId === 'ludo' ? 'ludo' : 'tictactoe';
    socket.emit('couple_game_state_sync', {
      gameId: targetGame,
      state: globalCoupleGamesState[targetGame] || {},
      activeChallenge: globalCoupleGamesState.activeChallenge
    });
  });

  socket.on('couple_game_invite', (inviteData) => {
    globalCoupleGamesState.activeChallenge = inviteData;
    io.emit('couple_game_invite_broadcast', inviteData);

    try {
      const isSenderAdmin = inviteData.challengerRole === 'parent' || inviteData.challengerRole === 'admin';
      const targetRole = isSenderAdmin ? 'user' : 'parent';
      const gameLabel = inviteData.game === 'ludo' ? 'Ludo Royale (2P)' : 'Tic-Tac-Toe';
      const betLabel = inviteData.betAmount ? ` • ₹${inviteData.betAmount} Bet` : '';
      sendWebPushNotification({
        title: `🎲 ${inviteData.challenger} Challenged You!`,
        body: `${gameLabel}${betLabel} • Tap to join & play!`,
        targetRole,
        data: { type: 'game_invite', game: inviteData.game }
      });
    } catch (e) {}
  });

  socket.on('couple_game_accept', (data) => {
    globalCoupleGamesState.activeChallenge = null;
    io.emit('couple_game_invite_clear');
    io.emit('launch_game_session', data);
  });

  socket.on('couple_game_invite_clear', () => {
    globalCoupleGamesState.activeChallenge = null;
    io.emit('couple_game_invite_clear');
  });

  socket.on('request_peer_balance', (data) => {
    socket.broadcast.emit('request_peer_balance', data || {});
  });

  socket.on('user_sync_state', async (data) => {
    if (!data || !data.email) return;
    const cleanEmail = (data.email || '').toLowerCase().trim();
    const numBalance = typeof data.loveBalance === 'number' ? data.loveBalance : parseFloat(data.loveBalance);
    let user = memoryUsers.get(cleanEmail);
    if (!user && mongoose.connection.readyState === 1) {
      try {
        user = await UserModel.findOne({ email: cleanEmail }).lean();
      } catch (err) {}
    }
    const isDora = cleanEmail === 'arthurs10pc@gmail.com' ? false : (
      Boolean(user?.isDora) || 
      (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === cleanEmail)
    );

    if (!user) {
      const namePart = cleanEmail.split('@')[0];
      const capName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
      user = {
        email: cleanEmail,
        name: capName,
        firstName: capName,
        fullName: cleanEmail,
        role: cleanEmail === 'arthurs10pc@gmail.com' ? 'parent' : 'user',
        isAdmin: cleanEmail === 'arthurs10pc@gmail.com',
        isDora,
        loveBalance: isNaN(numBalance) ? 0 : numBalance,
        loveLedger: Array.isArray(data.loveLedger) ? sanitizeLedger(data.loveLedger) : [],
        lastLogin: new Date()
      };
    } else {
      user.isDora = isDora;
      if (!isNaN(numBalance)) user.loveBalance = numBalance;
      if (Array.isArray(data.loveLedger) && data.loveLedger.length > 0) {
        user.loveLedger = sanitizeLedger([...data.loveLedger, ...(user.loveLedger || [])]);
      }
      user.lastLogin = new Date();
    }
    memoryUsers.set(cleanEmail, user);

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { email: cleanEmail },
          { $set: { isDora: user.isDora, loveBalance: user.loveBalance, loveLedger: user.loveLedger, lastLogin: new Date() } },
          { upsert: true, new: true }
        );
      } catch (e) {}
    }

    const isActiveDora = user.isDora || (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail === cleanEmail);
    if (isActiveDora && !isNaN(numBalance)) {
      globalLoveBalanceState.activeDoraEmail = cleanEmail;
      globalLoveBalanceState.loveBalance = user.loveBalance;
      if (Array.isArray(user.loveLedger) && user.loveLedger.length > 0) {
        const adminTxs = (globalLoveBalanceState.loveLedger || []).filter(e => e && (e.target === 'admin' || (e.description && e.description.includes('[Darsh]'))));
        globalLoveBalanceState.loveLedger = sanitizeLedger([...user.loveLedger, ...adminTxs]);
      }
      persistLoveState();

      io.emit('love_balance_broadcast', {
        action: 'SYNC_STATE_RESPONSE',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        wishRequests: globalLoveBalanceState.wishRequests || []
      });
    }
    broadcastUsersDirectory();
  });

  // --- REAL-TIME LOVE BALANCE & WISHES SYNC ---
  socket.on('love_balance_action', (data) => {
    if (!data) return;

    // Security Gate: Manual adjust, set exact, clear ledger require Darsh/Admin authentication
    const adminRestrictedActions = ['CLEAR_LEDGER', 'SET_EXACT_BALANCE', 'MANUAL_ADJUSTMENT'];
    if (adminRestrictedActions.includes(data.action) && !isSocketAdmin(socket, data)) {
      console.warn('Unauthorized admin action attempt blocked:', data.action, 'from role:', socket.role);
      socket.emit('love_balance_error', { message: 'Access Denied: Only Admin (Darsh) can perform this action' });
      return;
    }

    if (data.action === 'CLEAR_LEDGER') {
      const target = data.target || 'user';
      const nowTs = Date.now();
      if (target === 'user') {
        globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(item => item && (item.target === 'admin' || (item.description && item.description.includes('[Darsh]'))));
        globalLoveBalanceState.userLastClearedAt = nowTs;
      } else if (target === 'admin') {
        globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(item => item && item.target !== 'admin' && !(item.description && item.description.includes('[Darsh]')));
        globalLoveBalanceState.adminLastClearedAt = nowTs;
      } else {
        globalLoveBalanceState.loveLedger = [];
        globalLoveBalanceState.lastClearedAt = nowTs;
        globalLoveBalanceState.userLastClearedAt = nowTs;
        globalLoveBalanceState.adminLastClearedAt = nowTs;
      }
      globalLoveBalanceState.lastClearedAt = nowTs;
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
      syncActiveDoraUserBalance();

      const clearPayload = {
        action: 'CLEAR_LEDGER',
        target,
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        serverTimestamp: nowTs
      };
      io.emit('love_balance_action', clearPayload);
      io.emit('love_balance_broadcast', clearPayload);
      io.emit('love_balance_heartbeat_sync', {
        activeDoraEmail: globalLoveBalanceState.activeDoraEmail || '',
        loveBalance: globalLoveBalanceState.loveBalance,
        adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        loveLedger: globalLoveBalanceState.loveLedger,
        serverTimestamp: nowTs
      });
      return;
    } else if (data.action === 'DELETE_TRANSACTION' && data.transactionId) {
      if (!Array.isArray(globalLoveBalanceState.deletedTransactionIds)) {
        globalLoveBalanceState.deletedTransactionIds = [];
      }
      globalLoveBalanceState.deletedTransactionIds.push(data.transactionId);
      globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(e => e && e.id !== data.transactionId);
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
      syncActiveDoraUserBalance();
    } else if (data.action === 'TRANSACTION') {
      if (data.newEntry) {
        const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
        if (!delTxs.includes(data.newEntry.id)) {
          globalLoveBalanceState.loveLedger = [data.newEntry, ...globalLoveBalanceState.loveLedger.filter(e => e.id !== data.newEntry.id)];
          if (data.newEntry.description && data.newEntry.description.includes('Instant Reply')) {
            if (!globalLoveBalanceState.lastInstantReplyTime) {
              globalLoveBalanceState.lastInstantReplyTime = {};
            }
            const tgt = data.newEntry.target || data.target || 'user';
            globalLoveBalanceState.lastInstantReplyTime[tgt] = Date.now();
          }
        }
      }
      globalLoveBalanceState.loveLedger = sanitizeLedger(globalLoveBalanceState.loveLedger);
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
      syncActiveDoraUserBalance();

      // Send Web Push notification to mobile phone
      try {
        const isCredit = data.type === 'credit';
        const targetLabel = data.target === 'admin' ? 'Darsh' : 'Dora';
        const sign = isCredit ? '+' : '-';
        const amt = Number(data.amount || (data.newEntry && data.newEntry.points) || 0).toFixed(2);
        const reason = data.reason || (data.newEntry && data.newEntry.description) || (isCredit ? 'Reward Credited' : 'Balance Deduction');
        sendWebPushNotification({
          title: `${isCredit ? '⚡ Point Awarded' : '📉 Balance Deducted'} • ${targetLabel} (${sign}₹${amt})`,
          body: reason,
          targetRole: data.target === 'admin' ? 'parent' : 'user',
          data: { type: 'balance', target: data.target }
        });
      } catch (pushErr) {
        console.warn('[WebPush] Error sending transaction push:', pushErr);
      }
    } else if (data.action === 'OVERRIDE_BALANCE') {
      const val = parseFloat(data.newBalance) || 0;
      const target = data.target || 'user';
      const curr = calculateNetBalance(globalLoveBalanceState.loveLedger, target);
      const diff = parseFloat((val - curr).toFixed(2));
      let newEntry = null;
      if (diff !== 0) {
        const type = diff > 0 ? 'credit' : 'debit';
        const numAmount = Math.abs(diff);
        const targetLabel = target === 'user' ? 'Dora' : 'Darsh';
        newEntry = {
          id: 'lb_adj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          sl: 1,
          target,
          description: '[' + targetLabel + '] Admin Balance Adjustment (' + (diff > 0 ? '+' : '') + diff.toFixed(2) + ')',
          earnedAt: getNowIstEarnedAt(),
          expireDate: '',
          points: type === 'credit' ? numAmount : -numAmount,
          type,
          remarks: 'Manual Balance Set by Admin',
          status: 'Confirmed'
        };
        globalLoveBalanceState.loveLedger = [newEntry, ...globalLoveBalanceState.loveLedger];
      }
      persistLoveState();
      syncActiveDoraUserBalance();
      data.newEntry = newEntry;
    } else if (data.action === 'REQUEST_SYNC') {
      evaluateRoutineAndHabitInfractions();
      if (Array.isArray(data.deletedSlotIds) && data.deletedSlotIds.length > 0) {
        globalLoveBalanceState.deletedSlotIds = Array.from(new Set([
          ...(globalLoveBalanceState.deletedSlotIds || []),
          ...data.deletedSlotIds
        ]));
      }
      if (Array.isArray(data.deletedTransactionIds) && data.deletedTransactionIds.length > 0) {
        globalLoveBalanceState.deletedTransactionIds = Array.from(new Set([
          ...(globalLoveBalanceState.deletedTransactionIds || []),
          ...data.deletedTransactionIds
        ]));
      }
      const activeDeleted = globalLoveBalanceState.deletedSlotIds || [];
      const delTxs = globalLoveBalanceState.deletedTransactionIds || [];
      
      // Filter out any deleted transactions strictly
      globalLoveBalanceState.loveLedger = sanitizeLedger(globalLoveBalanceState.loveLedger).filter(e => e && !delTxs.includes(e.id));
      syncBalancesFromLedger();
      persistLoveState();

      // Immediately respond with authoritative master state to the requesting client
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
        lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
        serverTimestamp: Date.now()
      });

      if (Array.isArray(data.clientWishRequests) && data.clientWishRequests.length > 0) {
        const mergedW = [...(globalLoveBalanceState.wishRequests || [])];
        for (const w of data.clientWishRequests) {
          if (w && w.id && !mergedW.some(m => m && m.id === w.id)) mergedW.push(w);
        }
        globalLoveBalanceState.wishRequests = mergedW;
      }
      return;
    } else if (data.action === 'DAILY_SLOT_DELETE' && data.slotId) {
      const allDeleted = Array.from(new Set([
        ...(globalLoveBalanceState.deletedSlotIds || []),
        data.slotId,
        ...(Array.isArray(data.deletedSlotIds) ? data.deletedSlotIds : [])
      ]));
      globalLoveBalanceState.deletedSlotIds = allDeleted;
      memoryDailySlots = memoryDailySlots.filter(s => s && !allDeleted.includes(s.id));
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        DailyTaskSlot.deleteMany({ id: { $in: allDeleted } }).catch(() => {});
        DailyTaskSlot.deleteOne({ id: data.slotId }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: allDeleted });
      io.emit('love_balance_broadcast', {
        action: 'DAILY_SLOT_DELETE',
        slotId: data.slotId,
        deletedSlotIds: allDeleted,
        dailySlots: memoryDailySlots
      });
      io.emit('togepi_movie_chat', {
        room: GLOBAL_ROOM,
        senderRole: 'parent',
        text: `__SLOT_DELETE__:${JSON.stringify({ slotId: data.slotId, deletedSlotIds: allDeleted })}`
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

      // Master Server Persistence: Award Love Balance credit to Dora
      const approvalId = 'lb_appr_' + (data.submissionId || `${data.date}_${data.slotId}`);
      const alreadyAwarded = (globalLoveBalanceState.loveLedger || []).some(e => e && e.id === approvalId);
      if (!alreadyAwarded && pts > 0) {
        const slotTitle = data.slotTitle || 'Routine Task';
        const nowStr = getNowIstEarnedAt();
        const expDate = new Date();
        expDate.setMonth(expDate.getMonth() + 1);
        const creditEntry = {
          id: approvalId,
          sl: 1,
          target: 'user',
          description: `[Dora] Approved Task: ${slotTitle}`,
          earnedAt: nowStr,
          expireDate: expDate.toLocaleDateString('en-GB'),
          points: pts,
          type: 'credit',
          remarks: `Approved Task: ${slotTitle}`,
          status: 'Confirmed'
        };
        globalLoveBalanceState.loveLedger = [creditEntry, ...(globalLoveBalanceState.loveLedger || [])];
        globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
        globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
        persistLoveState();
      }
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
          DailyTaskSlot.findOneAndUpdate({ id: data.slotId }, data.updates, { upsert: true, new: true }).catch(() => {});
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
      evaluateRoutineAndHabitInfractions();
      const targetDate = date || getISTDateString();
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
      const targetDate = date || getISTDateString();
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

      // Send Web Push notification to Darsh mobile screen
      sendWebPushNotification({
        title: '📸 Task Proof Submitted',
        body: `[Dora] submitted proof for ${slotTitle || 'Routine Task'}`,
        targetRole: 'parent',
        data: { type: 'task_submission' }
      });
    } catch (err) {
      console.error('Error in daily_task_submit:', err);
    }
  });

  socket.on('daily_task_approve', async (payload) => {
    try {
      if (!isSocketAdmin(socket, payload)) {
        console.warn('Unauthorized daily_task_approve blocked from socket:', socket.id, socket.role);
        socket.emit('love_balance_error', { message: 'Access Denied: Only Admin (Darsh) can approve routine tasks' });
        return;
      }
      const { submissionId, slotId, date, feedback, slotTitle } = payload || {};
      if (!submissionId && !slotId) return;
      const pts = parseFloat(payload?.points ?? payload?.pointsAwarded) || 2.0;
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
          id: submissionId || `sub_${date || getISTDateString()}_${slotId}`,
          slotId: slotId || '',
          date: date || getISTDateString(),
          status: 'APPROVED',
          pointsAwarded: pts,
          reviewedAt: new Date(),
          adminFeedback: feedback || 'Approved by Darsh'
        };
        memoryDailySubmissions.push(updatedSubmission);
      }

      // Award Love Balance points to Dora (deduplicated strictly by approval ID)
      if (pts > 0) {
        const targetDate = date || (updatedSubmission && updatedSubmission.date) || getISTDateString();
        const approvalEntryId = 'lb_appr_' + (submissionId || `${targetDate}_${slotId}`);
        const taskName = slotTitle || (updatedSubmission && updatedSubmission.slotTitle) || 'Daily Routine Task';
        const missedDebitId = `habit_routine_${slotId}_${targetDate}_user`;

        // Cancel and remove any previously added missed debit penalty for this approved slot
        globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(e => e && e.id !== missedDebitId);

        const alreadyExists = (globalLoveBalanceState.loveLedger || []).some(e => e && e.id === approvalEntryId);
        if (!alreadyExists) {
          const newEntry = {
            id: approvalEntryId,
            sl: 1,
            target: 'user',
            description: '[Dora] Approved Task: ' + taskName,
            earnedAt: getNowIstEarnedAt(),
            expireDate: '',
            points: pts,
            type: 'credit',
            remarks: 'Daily Routine Task Approved by Darsh',
            status: 'Confirmed'
          };
          globalLoveBalanceState.loveLedger = [newEntry, ...(globalLoveBalanceState.loveLedger || [])];
        }
        persistLoveState();
        syncActiveDoraUserBalance();
        broadcastUsersDirectory();

        io.emit('love_balance_broadcast', {
          action: 'TRANSACTION',
          target: 'user',
          amount: pts,
          type: 'credit',
          reason: 'Daily Task Approved: ' + taskName,
          loveLedger: globalLoveBalanceState.loveLedger,
          currentLoveBalance: globalLoveBalanceState.loveBalance,
          currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          serverTimestamp: Date.now()
        });

        // Send Web Push notification to Dora mobile screen
        sendWebPushNotification({
          title: `🎉 Task Approved by Darsh! (+₹${Number(pts).toFixed(2)})`,
          body: `Approved: ${taskName}`,
          targetRole: 'user',
          data: { type: 'task_approved' }
        });

        io.emit('love_balance_heartbeat_sync', {
          activeDoraEmail: globalLoveBalanceState.activeDoraEmail || '',
          loveBalance: globalLoveBalanceState.loveBalance,
          adminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          currentLoveBalance: globalLoveBalanceState.loveBalance,
          currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
          loveLedger: globalLoveBalanceState.loveLedger,
          wishRequests: globalLoveBalanceState.wishRequests,
          dailySubmissions: memoryDailySubmissions,
          dailySlots: (memoryDailySlots || []).filter(s => s && !(globalLoveBalanceState.deletedSlotIds || []).includes(s.id)),
          deletedSlotIds: globalLoveBalanceState.deletedSlotIds || [],
          deletedTransactionIds: globalLoveBalanceState.deletedTransactionIds || [],
          lastClearedAt: globalLoveBalanceState.lastClearedAt || 0,
          serverTimestamp: Date.now()
        });

        // Send Web Push notification to Dora mobile screen
        sendWebPushNotification({
          title: `🎉 Task Approved by Darsh! (+₹${Number(pts).toFixed(2)})`,
          body: `Approved: ${taskName}`,
          targetRole: 'user',
          data: { type: 'task_approved' }
        });
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

  socket.on('daily_task_reject', async (payload) => {
    try {
      if (!isSocketAdmin(socket, payload)) {
        console.warn('Unauthorized daily_task_reject attempt blocked from socket:', socket.id);
        socket.emit('love_balance_error', { message: 'Access Denied: Only Admin (Darsh) can reject routine tasks' });
        return;
      }
      const { submissionId, feedback } = payload || {};
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
      evaluateRoutineAndHabitInfractions();
    } catch (err) {
      console.error('Error in daily_task_reject:', err);
    }
  });

  socket.on('daily_task_delete_submission', async (payload) => {
    try {
      if (!isSocketAdmin(socket, payload)) {
        console.warn('Unauthorized daily_task_delete_submission blocked from socket:', socket.id);
        return;
      }
      const { submissionId, slotId, date, approvalId } = payload || {};
      if (!submissionId && !slotId) return;

      if (mongoose.connection.readyState === 1) {
        const query = submissionId ? { id: submissionId } : { slotId: slotId, date: date };
        await DailyTaskSubmission.deleteMany(query).catch(err => console.error('Error deleting DailyTaskSubmission in Mongo:', err));
      }

      // Remove from memoryDailySubmissions
      const removeIdx = memoryDailySubmissions.findIndex(s => 
        (submissionId && s.id === submissionId) || (slotId && s.slotId === slotId && (!date || s.date === date))
      );
      if (removeIdx !== -1) {
        memoryDailySubmissions.splice(removeIdx, 1);
      }

      // Remove approval transaction from loveLedger
      const apprId = approvalId || ('lb_appr_' + (submissionId || `${date}_${slotId}`));
      globalLoveBalanceState.loveLedger = (globalLoveBalanceState.loveLedger || []).filter(e => 
        e && e.id !== apprId && !(slotId && e.id && e.id.includes(slotId))
      );
      globalLoveBalanceState.loveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'user');
      globalLoveBalanceState.adminLoveBalance = calculateNetBalance(globalLoveBalanceState.loveLedger, 'admin');
      persistLoveState();
      syncActiveDoraUserBalance();

      io.emit('daily_task_submission_deleted', {
        submissionId,
        slotId,
        date: date || getISTDateString(),
        approvalId: apprId
      });

      io.emit('love_balance_broadcast', {
        action: 'DELETE_TRANSACTION',
        transactionId: apprId,
        loveLedger: globalLoveBalanceState.loveLedger,
        currentLoveBalance: globalLoveBalanceState.loveBalance,
        currentAdminLoveBalance: globalLoveBalanceState.adminLoveBalance,
        serverTimestamp: Date.now()
      });
    } catch (err) {
      console.error('Error in daily_task_delete_submission:', err);
    }
  });

  socket.on('daily_slot_create', async (slotData) => {
    try {
      if (!isSocketAdmin(socket, slotData)) {
        console.warn('Unauthorized daily_slot_create attempt blocked');
        return;
      }
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
      memoryDailySlots = sortSlotsByTime(memoryDailySlots);
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

  socket.on('daily_slot_update', async (data) => {
    try {
      if (!isSocketAdmin(socket, data)) {
        console.warn('Unauthorized daily_slot_update attempt blocked');
        return;
      }
      const { slotId, updates } = data || {};
      if (!slotId) return;
      const idx = memoryDailySlots.findIndex(s => s.id === slotId);
      if (idx >= 0) {
        memoryDailySlots[idx] = { ...memoryDailySlots[idx], ...updates };
      }
      memoryDailySlots = sortSlotsByTime(memoryDailySlots);
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        DailyTaskSlot.findOneAndUpdate({ id: slotId }, updates, { upsert: true, new: true }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: globalLoveBalanceState.deletedSlotIds });
    } catch (err) {
      console.error('Error in daily_slot_update:', err);
    }
  });

  socket.on('daily_slot_delete', async (data) => {
    try {
      if (!isSocketAdmin(socket, data)) {
        console.warn('Unauthorized daily_slot_delete attempt blocked');
        return;
      }
      const { slotId, deletedSlotIds } = data || {};
      if (!slotId) return;
      const allDeleted = Array.from(new Set([
        ...(globalLoveBalanceState.deletedSlotIds || []),
        slotId,
        ...(Array.isArray(deletedSlotIds) ? deletedSlotIds : [])
      ]));
      globalLoveBalanceState.deletedSlotIds = allDeleted;
      memoryDailySlots = memoryDailySlots.filter(s => s && !allDeleted.includes(s.id));
      globalLoveBalanceState.dailySlots = memoryDailySlots;
      persistLoveState();
      if (mongoose.connection.readyState === 1) {
        await DailyTaskSlot.deleteMany({ id: { $in: allDeleted } }).catch(() => {});
        await DailyTaskSlot.deleteOne({ id: slotId }).catch(() => {});
      }
      io.emit('daily_slots_updated', { slots: memoryDailySlots, deletedSlotIds: allDeleted });
      io.emit('love_balance_broadcast', {
        action: 'DAILY_SLOT_DELETE',
        slotId,
        deletedSlotIds: allDeleted,
        dailySlots: memoryDailySlots
      });
      io.emit('togepi_movie_chat', {
        room: GLOBAL_ROOM,
        senderRole: 'parent',
        text: `__SLOT_DELETE__:${JSON.stringify({ slotId, deletedSlotIds: allDeleted })}`
      });
    } catch (err) {
      console.error('Error in daily_slot_delete:', err);
    }
  });

  socket.on('sync_send_invite', ({ role }) => {
    socket.broadcast.emit('sync_receive_invite', { fromRole: role });
    try {
      const isSenderAdmin = role === 'parent' || role === 'admin';
      const targetRole = isSenderAdmin ? 'user' : 'parent';
      const senderName = isSenderAdmin ? 'Admin' : 'Dora';
      sendWebPushNotification({
        title: `🎵 ${senderName} Synced Music Lounge`,
        body: `Invitation sent! Tap to connect and listen together in real-time.`,
        targetRole,
        data: { type: 'music_sync_invite' }
      });
    } catch (e) {}
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

  socket.on('sync_queue_update', ({ queue }) => {
    if (Array.isArray(queue)) {
      globalSyncState.queue = [
        queue[0] || null,
        queue[1] || null,
        queue[2] || null
      ];
      io.emit('sync_queue_broadcast', { queue: globalSyncState.queue });
    }
  });

  socket.on('sync_track_ended', () => {
    if (Date.now() - (globalSyncState.lastAdvanceTime || 0) < 3000) return;
    globalSyncState.lastAdvanceTime = Date.now();

    const currentQueue = Array.isArray(globalSyncState.queue) ? globalSyncState.queue : [null, null, null];
    if (currentQueue[0]) {
      const nextSong = currentQueue[0];
      const newQueue = [
        currentQueue[1] || null,
        currentQueue[2] || null,
        null
      ];
      globalSyncState.queue = newQueue;
      globalSyncState.connected = true;
      globalSyncState.videoId = nextSong.videoId;
      globalSyncState.title = nextSong.title || nextSong.url || 'YouTube Track';
      globalSyncState.state = 'PLAY';
      globalSyncState.currentTime = 0;
      globalSyncState.lastUpdated = Date.now();

      io.emit('sync_track_update', { videoId: nextSong.videoId, title: globalSyncState.title });
      io.emit('sync_queue_broadcast', { queue: newQueue });
    } else {
      globalSyncState.state = 'PAUSE';
      io.emit('sync_playback_update', { state: 'PAUSE', currentTime: 0, timestamp: Date.now() });
    }
  });

  socket.on('sync_play_scheduled_slot', ({ index }) => {
    const currentQueue = Array.isArray(globalSyncState.queue) ? globalSyncState.queue : [null, null, null];
    const targetSong = currentQueue[index];
    if (targetSong) {
      const filtered = currentQueue.filter((_, idx) => idx !== index);
      const newQueue = [
        filtered[0] || null,
        filtered[1] || null,
        null
      ];
      globalSyncState.queue = newQueue;
      globalSyncState.connected = true;
      globalSyncState.videoId = targetSong.videoId;
      globalSyncState.title = targetSong.title || targetSong.url || 'YouTube Track';
      globalSyncState.state = 'PLAY';
      globalSyncState.currentTime = 0;
      globalSyncState.lastUpdated = Date.now();

      io.emit('sync_track_update', { videoId: targetSong.videoId, title: globalSyncState.title });
      io.emit('sync_queue_broadcast', { queue: newQueue });
    }
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
    try {
      await processStealthMessage(data);
    } catch (err) {
      console.error("Error in send_stealth_msg socket:", err);
    }
  });

  socket.on('mark_seen', async ({ room, viewerRole }) => {
    const targetRoom = room || 'stealth_master_room';
    const isDora = (viewerRole === 'user' || viewerRole === 'A');

    memoryMessages.forEach(m => {
      if (!room || m.room === targetRoom) {
        const isFromCounterpart = isDora 
          ? (m.senderRole === 'parent' || m.senderRole === 'admin' || m.senderRole === 'H')
          : (m.senderRole === 'user' || m.senderRole === 'A');
        if (isFromCounterpart) {
          m.isSeen = true;
          m.isDelivered = true;
        }
      }
    });

    io.to(targetRoom).emit('messages_marked_seen', { viewerRole });
    io.emit('messages_marked_seen', { viewerRole });

    if (mongoose.connection.readyState === 1) {
      const counterpartRoles = isDora ? ['parent', 'admin', 'H'] : ['user', 'A'];
      Message.updateMany(
        { room: targetRoom, senderRole: { $in: counterpartRoles }, isSeen: false },
        { $set: { isSeen: true, isDelivered: true } }
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
    const msg = memoryMessages.find(m => m && m._id === messageId);
    if (msg) msg.reaction = reaction;
    io.to(room).emit('update_message_reaction', { messageId, reaction });
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.updateOne({ _id: messageId }, { $set: { reaction } });
      }
    } catch (e) {}
  });

  socket.on('pin_stealth_msg', async ({ room, messageId, isPinned }) => {
    const msg = memoryMessages.find(m => m && m._id === messageId);
    if (msg) msg.isPinned = isPinned;
    io.to(room).emit('update_message_pinned', { messageId, isPinned });
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.updateOne({ _id: messageId }, { $set: { isPinned } });
      }
    } catch (e) {}
  });

  socket.on('star_stealth_msg', async ({ room, messageId, isStarred }) => {
    const msg = memoryMessages.find(m => m && m._id === messageId);
    if (msg) msg.isStarred = isStarred;
    io.to(room).emit('update_message_starred', { messageId, isStarred });
    try {
      if (mongoose.connection.readyState === 1) {
        await Message.updateOne({ _id: messageId }, { $set: { isStarred } });
      }
    } catch (e) {}
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

  socket.on('auth_identify', (profile) => {
    if (profile && profile.email) {
      const cleanEmail = profile.email.toLowerCase().trim();
      socket.email = cleanEmail;
      socket.userName = profile.name || (cleanEmail === 'arthurs10pc@gmail.com' ? 'Darsh' : 'Dora');
      socket.picture = profile.picture || '';
      socket.role = cleanEmail === 'arthurs10pc@gmail.com' ? 'parent' : 'user';

      activeRoomUsers.set(socket.id, {
        room: socket.roomName || 'stealth_master_room',
        role: socket.role,
        email: cleanEmail,
        name: socket.userName,
        picture: socket.picture,
        isForeground: true,
        lastHeartbeat: Date.now()
      });

      memoryUsers.set(cleanEmail, {
        email: cleanEmail,
        name: socket.userName,
        originalName: profile.originalName || profile.name || socket.userName,
        role: socket.role,
        isAdmin: socket.role === 'parent',
        picture: socket.picture,
        lastLogin: new Date()
      });

      broadcastPresence(socket.roomName);
      broadcastUsersDirectory();
    }
  });

  socket.on('request_users_directory', async () => {
    try {
      const data = await getUsersDirectoryData();
      socket.emit('users_directory_update', data);
    } catch (e) {}
  });

  socket.on('admin_set_dora', async ({ email, isDora }) => {
    if (!email) return;
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'arthurs10pc@gmail.com') return;
    try {
      await switchActiveDora(cleanEmail, isDora, socket.email || 'arthurs10pc@gmail.com');
    } catch (e) {
      console.error('Error in socket admin_set_dora:', e);
    }
  });

  socket.on('admin_delete_user', async ({ email }) => {
    if (!email) return;
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'arthurs10pc@gmail.com') return;

    memoryUsers.delete(cleanEmail);
    for (const [sId, info] of activeRoomUsers.entries()) {
      if (info.email && info.email.toLowerCase() === cleanEmail) {
        activeRoomUsers.delete(sId);
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.deleteMany({ email: cleanEmail });
      } catch (err) {}
    }

    if (globalLoveBalanceState.activeDoraEmail && globalLoveBalanceState.activeDoraEmail.toLowerCase() === cleanEmail) {
      globalLoveBalanceState.activeDoraEmail = '';
      globalLoveBalanceState.loveBalance = 0;
      persistLoveState();
    }

    broadcastUsersDirectory();
    io.emit('user_permanently_deleted', { email: cleanEmail, timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    activeRoomUsers.delete(socket.id);
    if (socket.roomName) {
      broadcastPresence(socket.roomName);
    }
    broadcastUsersDirectory();
    io.emit('peer_typing_status', { isTyping: false });
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: Date.now() });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Stealth chat backend running on port ${PORT}`);

  // --- RENDER FREE-TIER COLD START PREVENTER (KEEP-ALIVE SELF-PING) ---
  // Render Free Tier sleeps after 15 mins of inactivity.
  // Pinging /health every 10 minutes keeps the server warm and awake 24/7 with zero lag!
  const pingUrl = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL;
  if (pingUrl) {
    const https = require('https');
    const http = require('http');
    const client = pingUrl.startsWith('https') ? https : http;
    const targetEndpoint = `${pingUrl.replace(/\/$/, '')}/health`;
    
    setInterval(() => {
      try {
        client.get(targetEndpoint, (res) => {
          // Warm keep-alive success
        }).on('error', () => {
          // Network fluctuation ignore
        });
      } catch (e) {}
    }, 10 * 60 * 1000); // Every 10 mins
    console.log(`[KeepAlive] Scheduled self-ping to ${targetEndpoint} every 10 minutes.`);
  }
});