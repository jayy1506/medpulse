import { createRequire } from 'module';
import { NovaCourseContent } from '../models/NovaCourseContent.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';

const require = createRequire(import.meta.url);

/**
 * Text Extractor supporting PDF, Markdown, and Plain Text
 */
export const extractDocumentText = async ({ buffer, originalname, mimetype }) => {
  if (!buffer || buffer.length === 0) {
    throw new Error('File buffer is empty.');
  }

  const filename = (originalname || '').toLowerCase();

  if (mimetype === 'application/pdf' || filename.endsWith('.pdf')) {
    try {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(buffer);
      return {
        text: pdfData.text || '',
        numPages: pdfData.numpages || 1
      };
    } catch (pdfErr) {
      throw new Error(`Failed to extract text from PDF: ${pdfErr.message}`);
    }
  }

  if (
    mimetype === 'text/plain' ||
    mimetype === 'text/markdown' ||
    filename.endsWith('.txt') ||
    filename.endsWith('.md')
  ) {
    const text = buffer.toString('utf-8');
    return {
      text,
      numPages: 1
    };
  }

  throw new Error(`Unsupported file type: ${mimetype || filename}. Allowed types: .pdf, .txt, .md`);
};

/**
 * Splits text into overlapping chunks (~500 tokens / ~1800 chars, ~50 tokens / ~200 chars overlap)
 * Respects paragraph and sentence boundaries.
 */
export const chunkCurriculumText = (text, targetChunkSize = 1800, overlap = 200) => {
  if (!text || typeof text !== 'string') return [];

  const cleanedText = text.replace(/\r\n/g, '\n').trim();
  if (cleanedText.length <= targetChunkSize) {
    return [cleanedText];
  }

  const paragraphs = cleanedText.split(/\n\s*\n/);
  const chunks = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if ((currentChunk + '\n\n' + trimmedPara).length <= targetChunkSize) {
      currentChunk = currentChunk ? `${currentChunk}\n\n${trimmedPara}` : trimmedPara;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        // Calculate overlap from tail of currentChunk
        const overlapSlice = currentChunk.slice(Math.max(0, currentChunk.length - overlap));
        currentChunk = overlapSlice ? `${overlapSlice}\n\n${trimmedPara}` : trimmedPara;
      } else {
        // Single paragraph larger than targetChunkSize: split by sentences
        const sentences = trimmedPara.split(/(?<=[.!?])\s+/);
        let sentenceBuffer = '';

        for (const sentence of sentences) {
          if ((sentenceBuffer + ' ' + sentence).length <= targetChunkSize) {
            sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
          } else {
            if (sentenceBuffer) {
              chunks.push(sentenceBuffer.trim());
              const overlapSlice = sentenceBuffer.slice(Math.max(0, sentenceBuffer.length - overlap));
              sentenceBuffer = overlapSlice ? `${overlapSlice} ${sentence}` : sentence;
            } else {
              // Individual sentence larger than target: hard chunk
              chunks.push(sentence.slice(0, targetChunkSize).trim());
              sentenceBuffer = sentence.slice(targetChunkSize - overlap).trim();
            }
          }
        }

        if (sentenceBuffer) {
          currentChunk = sentenceBuffer;
        }
      }
    }
  }

  if (currentChunk && currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(c => c.length > 30);
};

/**
 * Keyword Extractor for hybrid retrieval
 */
export const extractCurriculumKeywords = (text = '') => {
  const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
    'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
    'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
    'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'now',
    'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she',
    'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there',
    'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
    'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you'
  ]);

  return Array.from(new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  ));
};

/**
 * Ingests an uploaded document into NovaCourseContent
 */
export const indexUploadedCurriculumFile = async ({
  file,
  subject,
  chapter,
  subtopic = '',
  pageNumber = 1
}) => {
  if (!file) {
    throw new Error('No file provided for curriculum indexing.');
  }

  const { text, numPages } = await extractDocumentText({
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: file.mimetype
  });

  if (!text || text.trim().length === 0) {
    throw new Error('Extracted text is empty or could not be parsed.');
  }

  const rawChunks = chunkCurriculumText(text);
  if (rawChunks.length === 0) {
    throw new Error('No viable content chunks generated from document.');
  }

  const sourceFile = file.originalname;
  const createdChunks = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const chunkText = rawChunks[i];
    const chunkId = `nova_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`;
    const vector = await generateEmbedding(`${subject} ${chapter} ${subtopic}\n${chunkText}`);
    const keywords = extractCurriculumKeywords(`${subject} ${chapter} ${subtopic} ${chunkText}`);
    const estimatedPage = Math.min(numPages, pageNumber + Math.floor((i / rawChunks.length) * numPages));

    const chunkDoc = await NovaCourseContent.create({
      chunkId,
      subject,
      chapter,
      subtopic: subtopic || `Section ${i + 1}`,
      pageNumber: estimatedPage,
      sourceFile,
      chunkIndex: i,
      title: `${subject} - ${chapter}: ${subtopic || `Part ${i + 1}`}`,
      text: chunkText,
      vector,
      keywords,
      tokens: Math.round(chunkText.length / 4)
    });

    createdChunks.push(chunkDoc);
  }

  return {
    sourceFile,
    subject,
    chapter,
    subtopic,
    chunkCount: createdChunks.length,
    numPages
  };
};

/**
 * Canonical Sample Nursing Curriculum across the 4 core subjects
 */
export const CANONICAL_COURSE_MODULES = [
  // Subject 1: Anatomy
  {
    subject: 'Anatomy',
    chapter: 'Cardiovascular Anatomy',
    subtopic: 'Heart Chambers & Great Vessels',
    pageNumber: 14,
    sourceFile: 'Anatomy_Ch4_Circulatory_System.pdf',
    text: `The human heart consists of four muscular chambers: the right atrium, right ventricle, left atrium, and left ventricle. Deoxygenated blood returns from systemic circulation via the superior and inferior vena cava into the right atrium. It passes through the tricuspid valve into the right ventricle, which pumps it through the pulmonary semilunar valve into the pulmonary trunk and pulmonary arteries to the lungs for gas exchange.
Oxygenated blood returns from the lungs via four pulmonary veins into the left atrium, traverses the bicuspid (mitral) valve into the thick-walled left ventricle, and is ejected through the aortic semilunar valve into the aorta for systemic delivery. The left ventricular myocardium is approximately three times thicker than the right ventricular wall to overcome high systemic vascular resistance.`
  },
  {
    subject: 'Anatomy',
    chapter: 'Cardiovascular Anatomy',
    subtopic: 'Coronary Circulation & Conduction Anatomy',
    pageNumber: 18,
    sourceFile: 'Anatomy_Ch4_Circulatory_System.pdf',
    text: `Coronary arteries branch directly from the base of the ascending aorta above the aortic valve cusps. The Left Main Coronary Artery divides into the Left Anterior Descending (LAD) artery, which supplies the anterior interventricular septum and anterior left ventricle, and the Circumflex artery. The Right Coronary Artery (RCA) supplies the right atrium, right ventricle, and the Sinoatrial (SA) and Atrioventricular (AV) nodal tissue in ~90% of individuals.
The intrinsic conduction pathway begins at the SA node (cardiac pacemaker) in the superior posterolateral wall of the right atrium, transmits through internodal tracts to the AV node in the inferior interatrial septum, proceeds down the Bundle of His, splits into right and left bundle branches, and terminates in Purkinje fibers.`
  },
  {
    subject: 'Anatomy',
    chapter: 'Respiratory Anatomy',
    subtopic: 'Laryngeal, Tracheobronchial & Alveolar Anatomy',
    pageNumber: 32,
    sourceFile: 'Anatomy_Ch2_Respiratory_System.pdf',
    text: `The respiratory tract is anatomically divided into the upper airway (nasal cavity, pharynx, larynx) and lower airway (trachea, bronchi, bronchioles, alveoli). The trachea is supported by 16-20 C-shaped hyaline cartilage rings that prevent collapse during inhalation. The trachea bifurcates at the carina (level of T4-T5) into the right and left primary bronchi. The right main bronchus is wider, shorter, and more vertical than the left, making it the most frequent site of aspirated foreign bodies.
The right lung has three lobes (superior, middle, inferior) divided by horizontal and oblique fissures; the left lung has two lobes (superior and inferior) separated by an oblique fissure, featuring the cardiac notch. Alveoli are surrounded by pulmonary capillaries and lined with Type I alveolar cells for gas diffusion and Type II alveolar cells that secrete surfactant.`
  },

  // Subject 2: Physiology
  {
    subject: 'Physiology',
    chapter: 'Cardiovascular & Hemodynamic Physiology',
    subtopic: 'Cardiac Output, Stroke Volume & Preload',
    pageNumber: 45,
    sourceFile: 'Physiology_Ch4_Circulatory_Physiology.pdf',
    text: `Cardiac Output (CO) is the volume of blood pumped by each ventricle per minute, calculated as CO = Heart Rate (HR) x Stroke Volume (SV). Normal adult resting cardiac output is approximately 4 to 8 L/min. Stroke volume is governed by three primary determinants: preload, afterload, and myocardial contractility.
Preload represents the end-diastolic myocardial stretch, directly reflecting ventricular filling volume. According to the Frank-Starling law of the heart, increased end-diastolic volume stretches myocardial sarcomeres toward their optimal length, increasing contractile force and subsequent stroke volume within physiological limits. Excessive overstretching, as observed in dilated cardiomyopathy or end-stage congestive heart failure, diminishes ejection efficiency.`
  },
  {
    subject: 'Physiology',
    chapter: 'Renal Physiology',
    subtopic: 'Glomerular Filtration & RAAS Regulation',
    pageNumber: 68,
    sourceFile: 'Physiology_Ch9_Renal_System.pdf',
    text: `The functional unit of the kidney is the nephron, numbering approximately 1 million per kidney. Glomerular Filtration Rate (GFR) averages 125 mL/min (180 L/day) in healthy adults, driven by glomerular capillary hydrostatic pressure opposing Bowman capsule hydrostatic pressure and plasma oncotic pressure.
When renal perfusion pressure drops, juxtaglomerular cells in afferent arterioles release renin. Renin cleaves circulating angiotensinogen (from liver) into angiotensin I. Angiotensin-Converting Enzyme (ACE, primarily in pulmonary vascular endothelium) converts angiotensin I to angiotensin II. Angiotensin II is a potent systemic vasoconstrictor that preferentially constricts efferent arterioles to preserve GFR and stimulates the adrenal cortex to secrete aldosterone, promoting distal nephron sodium and water retention with potassium excretion.`
  },
  {
    subject: 'Physiology',
    chapter: 'Respiratory Physiology',
    subtopic: 'Ventilation-Perfusion Ratio & Surfactant',
    pageNumber: 52,
    sourceFile: 'Physiology_Ch2_Respiratory_Physiology.pdf',
    text: `Alveolar ventilation and pulmonary capillary perfusion normally match with an overall V/Q ratio of approximately 0.8. A V/Q mismatch occurs when ventilation and perfusion are unequal. A V/Q ratio approaching zero represents a physiological shunt (perfusion without ventilation, seen in atelectasis, severe pneumonia, or ARDS), which does not correct with supplemental oxygen alone. A high V/Q ratio represents alveolar dead space (ventilation without perfusion, classically caused by a pulmonary embolism).
Pulmonary surfactant, a lipoprotein complex synthesized and secreted by Type II pneumocytes, dramatically reduces alveolar surface tension at low lung volumes. By reducing surface tension, surfactant prevents alveolar collapse (atelectasis) at end-expiration, decreases the work of breathing, and maintains alveolar stability across varying alveolar sizes (Laplace law: P = 2T/r).`
  },

  // Subject 3: Clinical Biochemistry
  {
    subject: 'Clinical Biochemistry',
    chapter: 'Carbohydrate Metabolism & Clinical Disorders',
    subtopic: 'Blood Glucose Regulation & Diabetes Mellitus',
    pageNumber: 22,
    sourceFile: 'Biochem_Module1_Carbohydrate_Metabolism.pdf',
    text: `Normal fasting plasma glucose ranges from 70 to 99 mg/dL. Fasting blood glucose >= 126 mg/dL or Glycated Hemoglobin (HbA1c) >= 6.5% establishes the diagnosis of Diabetes Mellitus. Insulin is an anabolic peptide hormone secreted by pancreatic beta cells in response to elevated blood glucose; it facilitates glucose uptake into skeletal muscle and adipose tissue via GLUT-4 translocation and stimulates glycogenesis and lipogenesis while suppressing gluconeogenesis.
Glucagon, secreted by pancreatic alpha cells in response to hypoglycemia, stimulates hepatic glycogenolysis and gluconeogenesis. In Diabetic Ketoacidosis (DKA, predominantly in Type 1 Diabetes), absolute insulin deficiency causes unrestrained lipolysis, liberating free fatty acids that are converted in the liver into ketone bodies (acetoacetate, beta-hydroxybutyrate, acetone), leading to high-anion-gap metabolic acidosis (arterial pH < 7.30, serum bicarbonate < 18 mEq/L, and Kussmaul respirations).`
  },
  {
    subject: 'Clinical Biochemistry',
    chapter: 'Acid-Base Balance & Arterial Blood Gas',
    subtopic: 'ABG Interpretation & Henderson-Hasselbalch',
    pageNumber: 38,
    sourceFile: 'Biochem_Acid_Base_Regulation.pdf',
    text: `Arterial Blood Gas (ABG) reference values for adult patients are: pH: 7.35 to 7.45; PaCO2: 35 to 45 mmHg; PaO2: 80 to 100 mmHg; HCO3- (bicarbonate): 22 to 26 mEq/L; Base Excess: -2 to +2 mEq/L; SaO2: 95% to 100%.
The bicarbonate-carbonic acid buffer system is governed by the Henderson-Hasselbalch equation (pH = 6.1 + log([HCO3-] / (0.03 x PaCO2))).
1. Respiratory Acidosis: pH < 7.35 with PaCO2 > 45 mmHg (caused by hypoventilation, COPD, opioid overdose, respiratory depression).
2. Respiratory Alkalosis: pH > 7.45 with PaCO2 < 35 mmHg (caused by hyperventilation, panic attack, severe hypoxia).
3. Metabolic Acidosis: pH < 7.35 with HCO3- < 22 mEq/L (caused by DKA, lactic acidosis, renal failure, severe diarrhea).
4. Metabolic Alkalosis: pH > 7.45 with HCO3- > 26 mEq/L (caused by nasogastric suctioning, severe vomiting, excessive diuretic use).`
  },
  {
    subject: 'Clinical Biochemistry',
    chapter: 'Lipid & Lipoprotein Biochemistry',
    subtopic: 'Lipoproteins, Cholesterol & Atherosclerosis',
    pageNumber: 47,
    sourceFile: 'Biochem_Module2_Lipid_Metabolism.pdf',
    text: `Lipoproteins transport hydrophobic lipids through plasma: Chylomicrons transport dietary triglycerides from the intestine; Very Low-Density Lipoproteins (VLDL) carry endogenous triglycerides from the liver; Low-Density Lipoproteins (LDL) deliver cholesterol to peripheral tissues; High-Density Lipoproteins (HDL) carry cholesterol from tissues back to the liver in reverse cholesterol transport.
Elevated serum LDL-C (> 100 mg/dL, or > 70 mg/dL in high-risk patients) promotes oxidative modification of LDL particles in the subendothelial space of coronary arteries. Macrophages engulf oxidized LDL via scavenger receptors to become lipid-laden foam cells, initiating the fatty streak that progresses into atherosclerotic plaques with fibrous caps susceptible to rupture and acute coronary thrombosis.`
  },

  // Subject 4: Applied Nutrition
  {
    subject: 'Applied Nutrition',
    chapter: 'Macronutrients & Clinical Protein Balance',
    subtopic: 'Protein Requirements & Nitrogen Balance',
    pageNumber: 15,
    sourceFile: 'Nutrition_Ch1_Macronutrients.pdf',
    text: `The recommended dietary allowance (RDA) for protein in a healthy non-pregnant adult is 0.8 g/kg body weight/day. In hypercatabolic clinical states such as major burns, severe sepsis, multiple trauma, or post-surgical wound healing, protein requirements increase to 1.5 to 2.0 g/kg/day to maintain positive nitrogen balance and support tissue synthesis.
Nitrogen balance is calculated as: Nitrogen Balance = (Protein Intake in grams / 6.25) - (Urinary Urea Nitrogen in grams + 4 g for insensible losses). Negative nitrogen balance indicates that protein breakdown exceeds synthesis, leading to muscle wasting, impaired wound healing, and hypoalbuminemia (serum albumin < 3.5 g/dL). Kwashiorkor results from severe protein deficiency with adequate caloric intake (marked by bilateral pitting edema, ascites, and fatty liver), whereas Marasmus results from severe total caloric and protein starvation (marked by generalized somatic muscle and subcutaneous fat wasting).`
  },
  {
    subject: 'Applied Nutrition',
    chapter: 'Micronutrients & Clinical Deficiencies',
    subtopic: 'Vitamins, Electrolytes & Anemias',
    pageNumber: 29,
    sourceFile: 'Nutrition_Ch3_Micronutrients.pdf',
    text: `Micronutrient deficiencies produce distinct clinical manifestations in nursing assessments:
1. Vitamin D & Calcium: Vitamin D3 (cholecalciferol) is converted in the liver to 25(OH)D and in the kidneys to active 1,25(OH)2D (calcitriol) to stimulate intestinal calcium and phosphate absorption. Deficiency causes rickets in children and osteomalacia/osteoporosis in adults with hypocalcemia (positive Chvostek and Trousseau signs).
2. Vitamin B12 (Cobalamin): Requires gastric intrinsic factor secreted by parietal cells for ileal absorption. Deficiency leads to pernicious anemia (megaloblastic macrocytic anemia with MCV > 100 fL) and neurological impairment (subacute combined degeneration of the spinal cord with paresthesias and ataxia).
3. Iron: Microcytic hypochromic anemia (low ferritin, high TIBC), fatigue, pallor, and koilonychia (spoon nails). Dietary non-heme iron absorption is enhanced by ascorbic acid (Vitamin C).`
  },
  {
    subject: 'Applied Nutrition',
    chapter: 'Enteral & Parenteral Clinical Nutrition',
    subtopic: 'Tube Feeding & Refeeding Syndrome',
    pageNumber: 42,
    sourceFile: 'Nutrition_Ch5_Clinical_Nutrition.pdf',
    text: `Enteral nutrition (tube feeding via nasogastric, gastrostomy, or jejunostomy tube) is preferred over parenteral nutrition whenever the gastrointestinal tract is functional ("if the gut works, use it"). Nursing precautions for enteral feeding include elevating the head of the bed to 30-45 degrees during and for at least 1 hour after feeds to prevent pulmonary aspiration, confirming tube position via pH testing (< 5.5) or abdominal X-ray prior to initial use, and monitoring gastric residual volume.
Refeeding Syndrome is a life-threatening metabolic complication that occurs when aggressive carbohydrate refeeding is initiated in chronically malnourished patients (e.g. anorexia nervosa, chronic alcoholism, severe prolonged starvation). Carbohydrate intake triggers a surge in insulin, driving phosphate, potassium, and magnesium into cells. Severe hypophosphatemia (< 2.0 mg/dL) precipitates cardiac arrhythmias, acute heart failure, neuromuscular weakness, and respiratory failure. Serum electrolytes must be checked and corrected prior to advancing nutritional support.`
  }
];

/**
 * Seeds canonical course curriculum into NovaCourseContent
 */
export const seedCanonicalCurriculum = async () => {
  const count = await NovaCourseContent.countDocuments();
  if (count >= CANONICAL_COURSE_MODULES.length) {
    return { count, message: 'Nova canonical curriculum already seeded.' };
  }

  let seededCount = 0;
  for (let i = 0; i < CANONICAL_COURSE_MODULES.length; i++) {
    const mod = CANONICAL_COURSE_MODULES[i];
    const chunkId = `canon_${mod.subject.toLowerCase().replace(/\s+/g, '_')}_${i}`;

    const exists = await NovaCourseContent.findOne({ chunkId });
    if (!exists) {
      const vector = await generateEmbedding(`${mod.subject} ${mod.chapter} ${mod.subtopic}\n${mod.text}`);
      const keywords = extractCurriculumKeywords(`${mod.subject} ${mod.chapter} ${mod.subtopic} ${mod.text}`);

      await NovaCourseContent.create({
        chunkId,
        subject: mod.subject,
        chapter: mod.chapter,
        subtopic: mod.subtopic,
        pageNumber: mod.pageNumber,
        sourceFile: mod.sourceFile,
        chunkIndex: i,
        title: `${mod.subject} - ${mod.chapter}: ${mod.subtopic}`,
        text: mod.text,
        vector,
        keywords,
        tokens: Math.round(mod.text.length / 4)
      });
      seededCount++;
    }
  }

  return {
    seededCount,
    total: await NovaCourseContent.countDocuments()
  };
};

/**
 * List all unique indexed course materials
 */
export const listIndexedCurriculumMaterials = async () => {
  const chunks = await NovaCourseContent.find({}, 'chunkId subject chapter subtopic pageNumber sourceFile createdAt tokens')
    .sort({ subject: 1, chapter: 1, chunkIndex: 1 })
    .lean();

  // Group by subject and chapter
  const grouped = {};
  for (const c of chunks) {
    const key = `${c.subject} - ${c.chapter}`;
    if (!grouped[key]) {
      grouped[key] = {
        subject: c.subject,
        chapter: c.chapter,
        sourceFile: c.sourceFile,
        chunks: 0,
        subtopics: new Set(),
        totalPages: 0,
        tokens: 0,
        items: []
      };
    }
    grouped[key].chunks++;
    if (c.subtopic) grouped[key].subtopics.add(c.subtopic);
    grouped[key].tokens += c.tokens || 0;
    grouped[key].items.push(c);
  }

  return Object.values(grouped).map(g => ({
    subject: g.subject,
    chapter: g.chapter,
    sourceFile: g.sourceFile,
    chunkCount: g.chunks,
    subtopics: Array.from(g.subtopics),
    totalTokens: g.tokens,
    items: g.items
  }));
};

/**
 * Delete course content by chunkId or chapter
 */
export const deleteCurriculumContent = async (identifier) => {
  const byChunk = await NovaCourseContent.deleteOne({ chunkId: identifier });
  if (byChunk.deletedCount > 0) {
    return { deletedCount: byChunk.deletedCount, message: `Chunk ${identifier} deleted.` };
  }

  const byChapter = await NovaCourseContent.deleteMany({ chapter: identifier });
  return { deletedCount: byChapter.deletedCount, message: `Deleted ${byChapter.deletedCount} chunks for ${identifier}.` };
};
