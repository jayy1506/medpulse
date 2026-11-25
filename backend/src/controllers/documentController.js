import multer from 'multer';
import {
  indexUploadedDocument,
  retrieveRelevantDocumentChunks
} from '../services/ragDocumentService.js';
import {
  listDocuments,
  getDocument,
  deleteDocument
} from '../services/dbSqlite.js';

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/octet-stream' // Some markdown/txt files arrive as octet-stream
]);

const ALLOWED_EXTENSIONS = new Set(['pdf', 'txt', 'md']);

export const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, TXT, and Markdown files are supported.'));
    }
  }
});

export const handleUploadDocument = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No file uploaded. Please attach a PDF, TXT, or MD file.'
    });
  }

  try {
    const { document, chunkCount } = await indexUploadedDocument({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    res.status(201).json({
      success: true,
      message: 'Document successfully indexed for RAG retrieval.',
      document,
      chunkCount
    });
  } catch (err) {
    console.error('[DocumentController] Upload error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to process and index document.'
    });
  }
};

export const handleListDocuments = (req, res) => {
  try {
    const docs = listDocuments();
    res.json({
      success: true,
      documents: docs
    });
  } catch (err) {
    console.error('[DocumentController] List error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve indexed documents.'
    });
  }
};

export const handleDeleteDocument = (req, res) => {
  const { id } = req.params;
  try {
    const deleted = deleteDocument(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Document not found.'
      });
    }
    res.json({
      success: true,
      message: 'Document and its vector embeddings deleted successfully.'
    });
  } catch (err) {
    console.error('[DocumentController] Delete error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to delete document.'
    });
  }
};

export const handleSearchDocuments = async (req, res) => {
  const { query, topK, minSimilarity } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Query parameter is required.'
    });
  }

  try {
    const chunks = await retrieveRelevantDocumentChunks({
      query: query.trim(),
      topK: topK ? parseInt(topK, 10) : 5,
      minSimilarity: minSimilarity ? parseFloat(minSimilarity) : 0.45
    });
    res.json({
      success: true,
      query,
      count: chunks.length,
      chunks
    });
  } catch (err) {
    console.error('[DocumentController] Search error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to search document vectors.'
    });
  }
};
