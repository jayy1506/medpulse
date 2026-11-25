import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkDocumentText,
  cosineSimilarity,
  indexUploadedDocument,
  retrieveRelevantDocumentChunks
} from '../src/services/ragDocumentService.js';
import {
  listDocuments,
  deleteDocument
} from '../src/services/dbSqlite.js';

test('Phase 2: Document RAG & Vector Retrieval Tests', async (t) => {

  await t.test('1. Chunker splits text into overlapping chunks', () => {
    const sampleText = 'Paragraph one on cardiac physiology.\n\nParagraph two on pulmonary gas exchange.\n\nParagraph three on renal glomerular filtration.\n\nParagraph four on endocrine regulation.\n\nParagraph five on neurovascular transmission.';
    const chunks = chunkDocumentText(sampleText, { chunkSize: 80, overlap: 20 });

    assert.ok(chunks.length >= 2, 'Should create multiple chunks');
    assert.equal(chunks[0].chunkIndex, 0);
    assert.equal(chunks[1].chunkIndex, 1);
    assert.ok(chunks[0].content.length > 0);
  });

  await t.test('2. Cosine similarity calculates mathematical similarity correctly', () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    const v3 = [0, 1, 0];
    const v4 = [-1, 0, 0];

    assert.equal(Math.round(cosineSimilarity(v1, v2) * 100) / 100, 1.0);
    assert.equal(Math.round(cosineSimilarity(v1, v3) * 100) / 100, 0.0);
    assert.equal(Math.round(cosineSimilarity(v1, v4) * 100) / 100, -1.0);
  });

  let createdDocId = null;

  await t.test('3. Index sample clinical document into SQLite vector store', async () => {
    const docText = `Clinical Nursing Protocol: Hypoglycemia Management (Rule of 15)
When a diabetic patient exhibits blood glucose below 70 mg/dL:
Step 1: Administer 15 grams of fast-acting simple carbohydrates (4 ounces of fruit juice, 1/2 can regular soda, or 3-4 glucose tablets).
Step 2: Wait 15 minutes and recheck capillary blood glucose.
Step 3: If blood glucose remains < 70 mg/dL, repeat 15 grams of simple carbs.
Step 4: Once glucose is above 70 mg/dL, provide a complex carbohydrate and protein snack (e.g. peanut butter crackers) to maintain euglycemia.
Severe unconscious hypoglycemia requires 1 mg intramuscular Glucagon or IV 50% Dextrose (D50W).`;

    const buffer = Buffer.from(docText, 'utf-8');
    const result = await indexUploadedDocument({
      buffer,
      originalname: 'Hypoglycemia_Protocol_2026.txt',
      mimetype: 'text/plain',
      size: buffer.length
    });

    assert.ok(result.document);
    createdDocId = result.document.id;
    assert.ok(result.chunkCount > 0);

    const docs = listDocuments();
    assert.ok(docs.some(d => d.id === createdDocId));
  });

  await t.test('4. Retrieve relevant chunks with semantic query', async () => {
    const chunks = await retrieveRelevantDocumentChunks({
      query: 'What is the Rule of 15 for low blood sugar?',
      topK: 3,
      minSimilarity: 0.1
    });

    assert.ok(chunks.length > 0, 'Should find relevant hypoglycemia protocol');
    assert.ok(chunks[0].content.includes('Hypoglycemia Management'));
    assert.equal(chunks[0].documentName, 'Hypoglycemia_Protocol_2026.txt');
  });

  await t.test('5. Delete indexed document and clean up vectors', () => {
    if (createdDocId) {
      const deleted = deleteDocument(createdDocId);
      assert.ok(deleted);
    }
  });

});
