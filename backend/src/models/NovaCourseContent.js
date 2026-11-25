import mongoose from 'mongoose';

const novaCourseContentSchema = new mongoose.Schema(
  {
    chunkId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    subject: {
      type: String,
      required: true,
      enum: ['Anatomy', 'Physiology', 'Clinical Biochemistry', 'Applied Nutrition', 'General Nursing'],
      index: true
    },
    chapter: {
      type: String,
      required: true,
      index: true
    },
    subtopic: {
      type: String,
      default: '',
      index: true
    },
    pageNumber: {
      type: Number,
      default: 1
    },
    sourceFile: {
      type: String,
      default: ''
    },
    chunkIndex: {
      type: Number,
      default: 0
    },
    title: {
      type: String,
      default: ''
    },
    text: {
      type: String,
      required: true
    },
    vector: {
      type: [Number],
      required: true
    },
    keywords: {
      type: [String],
      default: [],
      index: true
    },
    tokens: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

// Compound text index for lexical search fallback
novaCourseContentSchema.index({ text: 'text', title: 'text', subtopic: 'text' });

export const NovaCourseContent = mongoose.model('NovaCourseContent', novaCourseContentSchema);
