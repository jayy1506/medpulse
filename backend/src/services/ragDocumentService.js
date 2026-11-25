import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { generateGeminiEmbedding } from './geminiClient.js';
import {
  addDocument,
  addDocumentChunks,
  getAllChunksWithEmbeddings,
  listDocuments,
  getDocument,
  deleteDocument
} from './dbSqlite.js';

const CHUNK_SIZE_CHARS = 1800; // ~450-500 tokens
const CHUNK_OVERLAP_CHARS = 200; // ~50 tokens
const DEFAULT_MIN_SIMILARITY = 0.45;

/**
 * Split text into overlapping chunks
 */
export const chunkDocumentText = (text, options = {}) => {
  const chunkSize = options.chunkSize || CHUNK_SIZE_CHARS;
  const overlap = options.overlap || CHUNK_OVERLAP_CHARS;

  if (!text || typeof text !== 'string') return [];

  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= chunkSize) {
    return [{
      chunkIndex: 0,
      pageNumber: 1,
      content: clean
    }];
  }

  const chunks = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < clean.length) {
    let endIndex = startIndex + chunkSize;

    // Try to break at paragraph or sentence boundary if not at end
    if (endIndex < clean.length) {
      const paragraphBreak = clean.lastIndexOf('\n\n', endIndex);
      if (paragraphBreak > startIndex + chunkSize * 0.6) {
        endIndex = paragraphBreak + 2;
      } else {
        const sentenceBreak = clean.lastIndexOf('. ', endIndex);
        if (sentenceBreak > startIndex + chunkSize * 0.6) {
          endIndex = sentenceBreak + 2;
        }
      }
    } else {
      endIndex = clean.length;
    }

    const chunkContent = clean.slice(startIndex, endIndex).trim();
    if (chunkContent.length > 20) {
      chunks.push({
        chunkIndex,
        pageNumber: 1,
        content: chunkContent
      });
      chunkIndex++;
    }

    startIndex = endIndex - overlap;
    if (startIndex >= clean.length - overlap) break;
  }

  return chunks;
};

/**
 * Calculate Cosine Similarity between two numeric vectors
 */
export const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Deterministic fallback embedding generator for testing or offline environments
 */
export const generateFallbackEmbedding = (text, dim = 128) => {
  const vec = new Float64Array(dim);
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (let c = 0; c < word.length; c++) {
      const idx = (word.charCodeAt(c) * (c + 1) * 31) % dim;
      vec[idx] += 1.0;
    }
  }
  let sumSq = 0;
  for (let i = 0; i < dim; i++) sumSq += vec[i] * vec[i];
  const mag = Math.sqrt(sumSq) || 1;
  return Array.from(vec).map(v => v / mag);
};

/**
 * Extract text from uploaded document buffer
 */
export const extractDocumentText = async (buffer, mimetype, originalname) => {
  const ext = (originalname.split('.').pop() || '').toLowerCase();

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    try {
      const data = await pdfParse(buffer);
      return {
        text: data.text || '',
        pageCount: data.numpages || 1
      };
    } catch (err) {
      console.warn('[RAG Document] PDF parse error, falling back to string:', err.message);
      return {
        text: buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' '),
        pageCount: 1
      };
    }
  }

  // Text or markdown file
  return {
    text: buffer.toString('utf-8'),
    pageCount: 1
  };
};

/**
 * Index an uploaded document into SQLite vector store
 */
export const indexUploadedDocument = async ({ buffer, originalname, mimetype, size }) => {
  const { text, pageCount } = await extractDocumentText(buffer, mimetype, originalname);

  if (!text || text.trim().length === 0) {
    throw new Error('Document contains no extractable text.');
  }

  const rawChunks = chunkDocumentText(text);
  if (rawChunks.length === 0) {
    throw new Error('Failed to create text chunks from document.');
  }

  const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const doc = addDocument({
    id: docId,
    name: originalname,
    mimeType: mimetype,
    sizeBytes: size,
    chunkCount: rawChunks.length
  });

  const chunksToInsert = [];
  for (const rawChunk of rawChunks) {
    let embedding = await generateGeminiEmbedding(rawChunk.content);
    if (!embedding || embedding.length === 0) {
      embedding = generateFallbackEmbedding(rawChunk.content);
    }

    chunksToInsert.push({
      id: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      document_id: docId,
      document_name: originalname,
      page_number: rawChunk.pageNumber,
      chunk_index: rawChunk.chunkIndex,
      content: rawChunk.content,
      embedding
    });
  }

  addDocumentChunks(chunksToInsert);

  return {
    document: doc,
    chunkCount: chunksToInsert.length
  };
};

/**
 * Retrieve top-k relevant document chunks by cosine similarity
 */
export const retrieveRelevantDocumentChunks = async ({
  query,
  topK = 5,
  minSimilarity = DEFAULT_MIN_SIMILARITY
}) => {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  let queryEmbedding = await generateGeminiEmbedding(query);
  let isFallback = false;
  if (!queryEmbedding || queryEmbedding.length === 0) {
    queryEmbedding = generateFallbackEmbedding(query);
    isFallback = true;
  }

  const allChunks = getAllChunksWithEmbeddings();
  if (allChunks.length === 0) return [];

  const scored = [];
  for (const chunk of allChunks) {
    let chunkVec = chunk.embedding;
    if (isFallback && chunkVec.length !== queryEmbedding.length) {
      chunkVec = generateFallbackEmbedding(chunk.content);
    } else if (!isFallback && chunkVec.length !== queryEmbedding.length) {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, chunkVec);
    if (similarity >= minSimilarity) {
      scored.push({
        id: chunk.id,
        documentId: chunk.document_id,
        documentName: chunk.document_name,
        pageNumber: chunk.page_number,
        chunkIndex: chunk.chunk_index,
        content: chunk.content,
        similarity
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
};
