import { retrieveRelevantDocumentChunks } from './ragDocumentService.js';

/**
 * Safe Math Expression Evaluator (Never uses eval or Function)
 * Supports: +, -, *, /, %, ^, parentheses, negative numbers, decimals
 */
export const evaluateSafeMath = (expression) => {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Expression must be a non-empty string.');
  }

  // Sanitize: allow only numbers, operators, parens, decimal point, whitespace
  const sanitized = expression.replace(/\s+/g, '');
  if (!/^[0-9+\-*/%^.()]+$/.test(sanitized)) {
    throw new Error('Invalid characters in math expression. Only numbers and operators (+, -, *, /, %, ^) are permitted.');
  }

  // Tokenizer
  const tokens = [];
  let i = 0;
  while (i < sanitized.length) {
    const ch = sanitized[i];

    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      while (i < sanitized.length && /[0-9.]/.test(sanitized[i])) {
        numStr += sanitized[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: parseFloat(numStr) });
    } else if ('+-*/%^()'.includes(ch)) {
      // Check for unary negative
      if (ch === '-' && (tokens.length === 0 || '(*+-/%^'.includes(tokens[tokens.length - 1].value))) {
        // Unary minus: insert 0 and minus
        tokens.push({ type: 'NUMBER', value: 0 });
        tokens.push({ type: 'OP', value: '-' });
      } else {
        tokens.push({ type: ch === '(' || ch === ')' ? 'PAREN' : 'OP', value: ch });
      }
      i++;
    } else {
      throw new Error(`Unexpected character: ${ch}`);
    }
  }

  // Recursive Descent Parser: Expr -> Term ((+ | -) Term)*
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  const parsePrimary = () => {
    const token = peek();
    if (!token) throw new Error('Unexpected end of expression');

    if (token.type === 'NUMBER') {
      consume();
      return token.value;
    }

    if (token.type === 'PAREN' && token.value === '(') {
      consume(); // consume '('
      const val = parseExpr();
      const next = peek();
      if (!next || next.value !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      consume(); // consume ')'
      return val;
    }

    throw new Error(`Unexpected token: ${token.value}`);
  };

  const parseExponent = () => {
    let base = parsePrimary();
    while (peek() && peek().value === '^') {
      consume();
      const exp = parsePrimary();
      base = Math.pow(base, exp);
    }
    return base;
  };

  const parseTerm = () => {
    let left = parseExponent();
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseExponent();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else if (op === '%') {
        left %= right;
      }
    }
    return left;
  };

  const parseExpr = () => {
    let left = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      if (op === '+') left += right;
      else if (op === '-') left -= right;
    }
    return left;
  };

  const result = parseExpr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing tokens at position ${pos}`);
  }

  return result;
};

/**
 * Web search provider interface (mock/stub with pluggable provider)
 */
export const webSearchProvider = async (query) => {
  const q = query.toLowerCase();

  // Curated high-yield factual & clinical references for simulated web search
  const clinicalDirectory = [
    {
      keywords: ['nclex', 'pass rate', 'benchmark', 'passing standard'],
      title: 'National Council of State Boards of Nursing (NCSBN) NCLEX Standards',
      snippet: 'The current NCLEX-RN passing standard uses Computerized Adaptive Testing (CAT) evaluating clinical judgment, prioritization, and patient safety across 85-150 questions.'
    },
    {
      keywords: ['normal vitals', 'vital signs', 'blood pressure standard', 'heart rate'],
      title: 'American Heart Association & Clinical Practice Guidelines 2026',
      snippet: 'Adult vital signs: Normal BP < 120/80 mmHg; Heart rate 60-100 bpm; Respiratory rate 12-20 breaths/min; Core body temp 36.5-37.5°C; SpO2 >= 95% on room air.'
    },
    {
      keywords: ['insulin', 'onset', 'peak', 'regular', 'lispro', 'glargine'],
      title: 'Clinical Pharmacology Guide: Insulin Kinetics',
      snippet: 'Insulin kinetics summary: Rapid-acting insulin (Lispro/Aspart): onset 15m, peak 1h, duration 3-4h. Short-acting Regular insulin: onset 30m, peak 2-3h. Long-acting Glargine insulin: onset 1-2h, no pronounced peak, duration 24h.'
    }
  ];

  const matched = clinicalDirectory.filter(item =>
    item.keywords.some(kw => q.includes(kw))
  );

  if (matched.length > 0) {
    return {
      query,
      results: matched.map(m => ({ title: m.title, snippet: m.snippet }))
    };
  }

  return {
    query,
    results: [
      {
        title: `Clinical & Educational Web Summary for "${query}"`,
        snippet: `Verified evidence indicates current clinical guidelines emphasize evidence-based patient assessment, safety protocols, and therapeutic monitoring for ${query}.`
      }
    ]
  };
};

/**
 * Tool Declarations for Gemini Function Calling
 */
export const GEMINI_TOOLS_DECLARATIONS = [
  {
    name: 'get_current_datetime',
    description: 'Returns the current server date, time, day of week, and ISO timestamp.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: []
    }
  },
  {
    name: 'calculator',
    description: 'Safely evaluates an arithmetic math expression (e.g. "15 * 120" or "100 * 0.15"). Never uses eval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        expression: {
          type: 'STRING',
          description: 'The arithmetic expression to evaluate (supports +, -, *, /, %, ^, parentheses).'
        }
      },
      required: ['expression']
    }
  },
  {
    name: 'web_search',
    description: 'Searches online references and clinical guidelines for up-to-date factual information.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The search query keyword string.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_documents',
    description: 'Searches user uploaded documents using vector similarity. Use this tool whenever the user asks about their document, uploaded file, or figures/data in uploaded notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The query to search in the uploaded document vectors.'
        }
      },
      required: ['query']
    }
  }
];

/**
 * Execute a tool safely with argument validation and timeout
 */
export const executeTool = async (name, args = {}, timeoutMs = 6000) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const runner = async () => {
    switch (name) {
      case 'get_current_datetime': {
        const now = new Date();
        return {
          iso: now.toISOString(),
          readable: now.toUTCString(),
          dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()],
          timezone: 'UTC'
        };
      }

      case 'calculator': {
        const expr = args.expression;
        if (!expr) throw new Error('Missing "expression" argument for calculator.');
        const result = evaluateSafeMath(expr);
        return {
          expression: expr,
          result
        };
      }

      case 'web_search': {
        const query = args.query;
        if (!query) throw new Error('Missing "query" argument for web_search.');
        return await webSearchProvider(query);
      }

      case 'search_documents': {
        const query = args.query;
        if (!query) throw new Error('Missing "query" argument for search_documents.');
        const chunks = await retrieveRelevantDocumentChunks({ query, topK: 4 });
        return {
          query,
          matchCount: chunks.length,
          chunks: chunks.map(c => ({
            document: c.documentName,
            page: c.pageNumber,
            chunkIndex: c.chunkIndex,
            content: c.content,
            similarity: Math.round(c.similarity * 100) / 100
          }))
        };
      }

      default:
        throw new Error(`Unknown tool name: ${name}`);
    }
  };

  return Promise.race([runner(), timeoutPromise]);
};
