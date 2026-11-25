import mongoose from 'mongoose';
import { NovaCourseContent } from '../models/NovaCourseContent.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';
import { extractCurriculumKeywords, CANONICAL_COURSE_MODULES } from './novaContentService.js';

// Configurable similarity threshold: minimum cosine similarity required for in-course confidence
const DEFAULT_MIN_SIMILARITY = 0.38;
const TOP_K = 5;

// In-memory cache of pre-embedded canonical modules for instant, zero-latency retrieval
let cachedCanonicalEmbeddings = null;

const getCachedCanonicalCandidates = async () => {
  if (cachedCanonicalEmbeddings) return cachedCanonicalEmbeddings;

  const candidates = [];
  for (let idx = 0; idx < CANONICAL_COURSE_MODULES.length; idx++) {
    const m = CANONICAL_COURSE_MODULES[idx];
    const textToEmbed = `${m.subject} ${m.chapter} ${m.subtopic}\n${m.text}`;
    const vector = await generateEmbedding(textToEmbed);
    candidates.push({
      chunkId: `mem_${idx}`,
      subject: m.subject,
      chapter: m.chapter,
      subtopic: m.subtopic,
      pageNumber: m.pageNumber,
      sourceFile: m.sourceFile,
      text: m.text,
      vector,
      keywords: extractCurriculumKeywords(`${m.subject} ${m.chapter} ${m.subtopic} ${m.text}`)
    });
  }
  cachedCanonicalEmbeddings = candidates;
  return cachedCanonicalEmbeddings;
};

/**
 * Calculates keyword overlap score between query keywords and a course chunk [0.0 - 1.0]
 */
export const calculateKeywordScore = (queryKeywords = [], chunk) => {
  if (!queryKeywords || queryKeywords.length === 0) return 0;

  const chunkKeywords = new Set(
    chunk.keywords && chunk.keywords.length > 0
      ? chunk.keywords
      : extractCurriculumKeywords(`${chunk.subject} ${chunk.chapter} ${chunk.subtopic} ${chunk.text}`)
  );

  let matches = 0;
  for (const kw of queryKeywords) {
    if (chunkKeywords.has(kw)) {
      matches += 1;
    }
  }

  return Math.min(1.0, matches / queryKeywords.length);
};

/**
 * Retrieve top-k relevant course chunks using hybrid vector similarity + keyword scoring
 * Filters by subject and chapter when specified.
 */
export const retrieveCurriculumChunks = async ({
  query,
  subject,
  chapter,
  allChapters = false,
  topK = TOP_K,
  minSimilarity = DEFAULT_MIN_SIMILARITY
}) => {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      found: false,
      chunks: [],
      bestScore: 0,
      citations: []
    };
  }

  const queryVector = await generateEmbedding(query);
  const queryKeywords = extractCurriculumKeywords(query);

  let candidates = [];

  // 1. If MongoDB is actively connected, query database
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const filter = {};
      if (!allChapters) {
        if (subject && subject !== 'All' && subject !== 'General Nursing') {
          filter.subject = subject;
        }
        if (chapter && chapter !== 'All') {
          filter.chapter = chapter;
        }
      }
      candidates = await NovaCourseContent.find(filter).lean();
      if (candidates.length === 0 && !allChapters) {
        candidates = await NovaCourseContent.find({}).lean();
      }
    } catch (dbErr) {
      console.warn('[NovaRetrieval] DB read error, using canonical cache:', dbErr.message);
    }
  }

  // 2. Fallback to cached canonical modules if DB is not connected or empty
  if (candidates.length === 0) {
    const canonical = await getCachedCanonicalCandidates();
    if (!allChapters && subject && subject !== 'All' && subject !== 'General Nursing') {
      candidates = canonical.filter(c => c.subject === subject);
      if (candidates.length === 0) candidates = canonical;
    } else {
      candidates = canonical;
    }
  }

  // Score candidates with hybrid cosine similarity (70%) + keyword overlap (30%)
  const scored = [];
  for (const cand of candidates) {
    let vectorScore = 0;
    if (cand.vector && cand.vector.length > 0) {
      vectorScore = cosineSimilarity(queryVector, cand.vector);
    } else {
      const candVec = await generateEmbedding(`${cand.subject} ${cand.chapter} ${cand.subtopic}\n${cand.text}`);
      vectorScore = cosineSimilarity(queryVector, candVec);
    }

    const keywordScore = calculateKeywordScore(queryKeywords, cand);
    const finalScore = Number((0.70 * vectorScore + 0.30 * keywordScore).toFixed(4));

    scored.push({
      ...cand,
      vectorScore: Number(vectorScore.toFixed(4)),
      keywordScore: Number(keywordScore.toFixed(4)),
      finalScore
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);

  const topChunks = scored.slice(0, topK);
  const bestScore = topChunks[0]?.finalScore || 0;

  // Filter chunks that meet the minimum threshold
  const filteredChunks = topChunks.filter(c => c.finalScore >= minSimilarity);

  if (filteredChunks.length === 0 || bestScore < minSimilarity) {
    return {
      found: false,
      chunks: [],
      bestScore,
      threshold: minSimilarity,
      citations: []
    };
  }

  const citations = filteredChunks.map(c => ({
    subject: c.subject || 'Nursing Curriculum',
    chapter: c.chapter || 'Core Module',
    subtopic: c.subtopic || 'General',
    pageNumber: c.pageNumber || 1,
    sourceFile: c.sourceFile || 'Course_Syllabus.pdf',
    similarity: c.finalScore,
    snippet: c.text.length > 180 ? `${c.text.substring(0, 180)}...` : c.text
  }));

  return {
    found: true,
    chunks: filteredChunks,
    bestScore,
    threshold: minSimilarity,
    citations
  };
};
