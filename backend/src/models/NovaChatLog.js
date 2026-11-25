import mongoose from 'mongoose';

const novaChatLogSchema = new mongoose.Schema(
  {
    userId: {
      type: String, // Firebase UID or MongoDB ObjectId
      required: true,
      index: true
    },
    userEmail: {
      type: String,
      default: ''
    },
    role: {
      type: String,
      default: 'student'
    },
    subject: {
      type: String,
      default: 'All'
    },
    chapter: {
      type: String,
      default: ''
    },
    query: {
      type: String,
      required: true
    },
    scope: {
      type: String,
      enum: ['in_scope', 'out_of_scope', 'greeting', 'unsafe_personal_medical'],
      required: true,
      index: true
    },
    response: {
      type: String,
      required: true
    },
    retrievedChunkIds: {
      type: [String],
      default: []
    },
    citations: [
      {
        subject: String,
        chapter: String,
        subtopic: String,
        pageNumber: Number,
        sourceFile: String,
        similarity: Number,
        snippet: String
      }
    ],
    latencyMs: {
      type: Number,
      default: 0
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

export const NovaChatLog = mongoose.model('NovaChatLog', novaChatLogSchema);
