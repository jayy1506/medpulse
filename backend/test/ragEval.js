import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexUploadedDocument,
  retrieveRelevantDocumentChunks
} from '../src/services/ragDocumentService.js';
import { deleteDocument } from '../src/services/dbSqlite.js';

const SAMPLE_CLINICAL_DOC = `
# MedPulse Clinical Reference Handbook: Critical Care & Pharmacology

## 1. Acute Myocardial Infarction Management
Immediate MONA protocol: Morphine for pain, Oxygen if SpO2 < 90%, Nitroglycerin sublingual every 5 minutes (max 3 doses, withhold if systolic BP < 90 mmHg), Aspirin 162-325 mg chewed immediately. Door-to-balloon time goal is under 90 minutes for PCI.

## 2. Diabetic Ketoacidosis (DKA) Treatment
DKA triad: Hyperglycemia (>250 mg/dL), metabolic acidosis (pH < 7.30, serum bicarbonate < 18 mEq/L), and ketonemia. Primary treatment is isotonic 0.9% NaCl fluid resuscitation (1-1.5 L in the first hour), followed by IV Regular Insulin infusion (0.1 units/kg/hr). Potassium must be >= 3.3 mEq/L before starting insulin.

## 3. Glasgow Coma Scale (GCS)
Maximum score is 15 (fully alert), minimum is 3 (deep coma). Three categories: Eye opening (1-4), Verbal response (1-5), Motor response (1-6). GCS <= 8 indicates severe brain injury requiring endotracheal intubation ("GCS of 8, intubate").

## 4. Anaphylaxis Emergency Response
First-line intervention is Epinephrine 1:1,000 (0.3 to 0.5 mg) administered intramuscularly into the anterolateral mid-thigh immediately. Repeat every 5 to 15 minutes as needed. Second-line adjuncts include H1 antihistamines (Diphenhydramine 50 mg IV) and Corticosteroids (Methylprednisolone 125 mg IV).

## 5. Potassium Imbalances & ECG
Normal serum potassium: 3.5 to 5.0 mEq/L. Hyperkalemia (>5.0 mEq/L) displays peaked T waves, prolonged PR interval, widened QRS, and ventricular fibrillation risk. Emergency stabilization: IV Calcium Gluconate 10% to stabilize the cardiac membrane, followed by regular insulin with D50W to shift potassium into cells.

## 6. Sepsis Hour-1 Bundle
Within 1 hour of sepsis recognition: 1) Measure serum lactate level; 2) Obtain blood cultures prior to antibiotics; 3) Administer broad-spectrum antibiotics; 4) Rapid administration of 30 mL/kg crystalloid for hypotension or lactate >= 4 mmol/L; 5) Apply vasopressors (Norepinephrine first-choice) if hypotensive during or after fluid resuscitation to maintain MAP >= 65 mmHg.

## 7. Blood Transfusion Protocols
Verify two licensed nurses at bedside. Pre-transfusion vitals taken immediately prior. Must begin infusion within 30 minutes of leaving blood bank. Remain with patient for first 15 minutes. Infuse through 18-20 gauge needle with 0.9% Normal Saline ONLY. Complete infusion within 4 hours.

## 8. Warfarin vs Heparin Antidotes
Unfractionated Heparin antidote is Protamine Sulfate (1 mg neutralizes ~100 units of heparin). Warfarin (Coumadin) antidote is Vitamin K (Phytonadione) and 4-factor Prothrombin Complex Concentrate (4F-PCC) for rapid reversal.

## 9. Stroke Assessment (BE-FAST & tPA Window)
BE-FAST: Balance loss, Eyes/vision changes, Facial droop, Arm weakness, Speech difficulty, Time to call code stroke. Intravenous Alteplase (tPA) or Tenecteplase must be administered within 4.5 hours of symptom onset after non-contrast head CT rules out hemorrhage. Blood pressure must be < 185/110 mmHg before tPA.

## 10. Chest Tube Drainage Management
Maintain drainage system below chest level at all times. Never clamp tube during transport. Continuous bubbling in water seal chamber indicates an air leak. Expected drainage should decrease over time; notify physician if drainage exceeds 100 mL/hour or suddenly turns bright red.
`;

const EVAL_DATASET = [
  {
    id: 1,
    question: 'What is the door-to-balloon time goal for PCI in myocardial infarction?',
    expectedKeywords: ['90 minutes', 'PCI', 'door-to-balloon']
  },
  {
    id: 2,
    question: 'What must potassium levels be before starting insulin in DKA?',
    expectedKeywords: ['3.3', 'potassium', 'insulin']
  },
  {
    id: 3,
    question: 'At what GCS score should a patient be intubated?',
    expectedKeywords: ['8', 'intubate', 'GCS']
  },
  {
    id: 4,
    question: 'What is the first-line medication and dose for anaphylaxis?',
    expectedKeywords: ['epinephrine', '0.3', 'intramuscular']
  },
  {
    id: 5,
    question: 'What medication stabilizes the cardiac membrane in severe hyperkalemia?',
    expectedKeywords: ['calcium gluconate', 'stabilize', 'membrane']
  },
  {
    id: 6,
    question: 'What is the first-choice vasopressor in septic shock to maintain MAP >= 65 mmHg?',
    expectedKeywords: ['norepinephrine', 'vasopressor', '65']
  },
  {
    id: 7,
    question: 'What is the only IV solution compatible with blood transfusions?',
    expectedKeywords: ['normal saline', '0.9%']
  },
  {
    id: 8,
    question: 'What is the antidote for unfractionated heparin overdose?',
    expectedKeywords: ['protamine sulfate', 'heparin']
  },
  {
    id: 9,
    question: 'What is the time window for intravenous tPA administration in acute ischemic stroke?',
    expectedKeywords: ['4.5 hours', 'tPA', 'stroke']
  },
  {
    id: 10,
    question: 'What does continuous bubbling in the water seal chamber of a chest tube indicate?',
    expectedKeywords: ['air leak', 'water seal']
  }
];

test('RAG Evaluation Benchmark: 10-Question Hit Rate & Correctness', async () => {
  // 1. Index sample document
  const buffer = Buffer.from(SAMPLE_CLINICAL_DOC, 'utf-8');
  const indexResult = await indexUploadedDocument({
    buffer,
    originalname: 'Critical_Care_Handbook_2026.md',
    mimetype: 'text/markdown',
    size: buffer.length
  });

  const docId = indexResult.document.id;
  console.log(`\n================ RAG EVALUATION BENCHMARK ================`);
  console.log(`Indexed sample document into ${indexResult.chunkCount} vector chunks.\n`);

  let hits = 0;
  let correctAnswers = 0;

  for (const item of EVAL_DATASET) {
    const retrieved = await retrieveRelevantDocumentChunks({
      query: item.question,
      topK: 3,
      minSimilarity: 0.1
    });

    const isHit = retrieved.length > 0;
    if (isHit) hits++;

    // Check if expected keywords are present in retrieved chunks
    const hasExpectedContent = retrieved.some(chunk => {
      const text = chunk.content.toLowerCase();
      return item.expectedKeywords.every(kw => text.includes(kw.toLowerCase()));
    });

    if (hasExpectedContent) {
      correctAnswers++;
      console.log(`[PASS] Q${item.id}: "${item.question.slice(0, 45)}..." -> Retrieved expected context (top sim: ${retrieved[0].similarity.toFixed(3)})`);
    } else {
      console.log(`[INFO] Q${item.id}: "${item.question.slice(0, 45)}..." -> Chunks missing expected keywords.`);
    }
  }

  const hitRate = (hits / EVAL_DATASET.length) * 100;
  const accuracy = (correctAnswers / EVAL_DATASET.length) * 100;

  console.log(`\n================ EVALUATION SUMMARY ================`);
  console.log(`Total Questions:    ${EVAL_DATASET.length}`);
  console.log(`Retrieval Hit Rate: ${hitRate.toFixed(1)}% (${hits}/${EVAL_DATASET.length})`);
  console.log(`Answer Precision:   ${accuracy.toFixed(1)}% (${correctAnswers}/${EVAL_DATASET.length})`);
  console.log(`====================================================\n`);

  // Clean up
  deleteDocument(docId);

  assert.ok(hitRate >= 90, `Hit rate should be at least 90%, got ${hitRate}%`);
  assert.ok(accuracy >= 80, `Answer precision should be at least 80%, got ${accuracy}%`);
});
