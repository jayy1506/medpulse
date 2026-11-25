import express from 'express';
import {
  upload,
  handleUploadDocument,
  handleListDocuments,
  handleDeleteDocument,
  handleSearchDocuments
} from '../controllers/documentController.js';

const router = express.Router();

// POST /api/documents - Upload & Index PDF, TXT, or MD
router.post('/', upload.single('document'), handleUploadDocument);

// GET /api/documents - List all indexed documents
router.get('/', handleListDocuments);

// DELETE /api/documents/:id - Delete a document & its chunks
router.delete('/:id', handleDeleteDocument);

// POST /api/documents/search - Direct search endpoint for testing/preview
router.post('/search', handleSearchDocuments);

export default router;
