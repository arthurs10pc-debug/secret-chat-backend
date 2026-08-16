const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// MongoDB Schema for Reminders
const ReminderSchema = new mongoose.Schema({
  userId: String,
  title: String,
  intervalMinutes: Number,
  message: String,
  enabled: Boolean
});
const Reminder = mongoose.model('Reminder', ReminderSchema);

// REST API Routes for Assistant Reminders
app.get('/api/reminders/:userId', async (req, res) => {
  try {
    const reminders = await Reminder.find({ userId: req.params.userId });
    res.json(reminders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reminders', async (req, res) => {
  try {
    const { userId, title, intervalMinutes, message, enabled } = req.body;
    const newReminder = new Reminder({ userId, title, intervalMinutes, message, enabled });
    await newReminder.save();
    res.json(newReminder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket Engine
io.on('connection', (socket) => {
  socket.on('join_secret_room', (roomCode) => socket.join(roomCode));
  socket.on('send_stealth_message', ({ roomCode, text }) => {
    socket.to(roomCode).emit('receive_stealth_message', {
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));