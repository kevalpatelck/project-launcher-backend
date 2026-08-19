const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  dir: {
    type: String,
    required: true,
    trim: true,
  },
  command: {
    type: String,
    required: true,
    trim: true,
    default: 'npm run dev',
  },
  port: {
    type: Number,
    default: null,
  },
  autoOpen: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Project', projectSchema);
