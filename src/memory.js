require('dotenv').config();

const crypto = require('crypto');
const { OpenAIEmbeddings, ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
const { run, all, get } = require('./db');

const EMBEDDING_MODEL = String(process.env.MEM_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
const EXTRACTION_MODEL = String(process.env.MEM_EXTRACTION_MODEL || 'gpt-5.4-nano').trim();
const MAX_CONTENT_CHARS = 1500;
const MAX_FACTS_PER_EXCHANGE = 5;

let _embedder = null;
let _extractor = null;

function isMemoryEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.MEM0_ENABLED || '').trim());
}

function getEmbedder() {
  if (_embedder) return _embedder;
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[memory] OPENAI_API_KEY not set, memory disabled');
    return null;
  }
  _embedder = new OpenAIEmbeddings({ apiKey, model: EMBEDDING_MODEL });
  return _embedder;
}

function getExtractor() {
  if (_extractor) return _extractor;
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  _extractor = new ChatOpenAI({
    apiKey,
    model: EXTRACTION_MODEL,
    temperature: 0,
    maxRetries: 1,
    useResponsesApi: false,
  });
  return _extractor;
}

const EXTRACTION_SYSTEM_PROMPT = [
  'You extract durable, reusable coaching facts about a GMAT student from a Q&A exchange.',
  'KEEP: persistent traits, weak/strong topics, stated goals, recurring mistake patterns, learning preferences, time-management habits, target score, study constraints.',
  'SKIP: ephemeral facts (specific session counts, transient feelings, one-off scores), things that change every session, generic GMAT advice, anything obvious.',
  'Each fact must be a short third-person declarative sentence starting with "user" (e.g. "user struggles with CR Strengthen on hard questions when rushed").',
  'Return JSON ONLY: {"facts": ["...", "..."]}. Empty list if nothing durable. Max 5 facts.',
].join('\n');

function parseFactsJson(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text);
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    return facts
      .map((f) => String(f || '').trim())
      .filter((f) => f && f.length <= 400)
      .slice(0, MAX_FACTS_PER_EXCHANGE);
  } catch {
    return [];
  }
}

async function extractFacts(exchangeText) {
  const extractor = getExtractor();
  if (!extractor) return null;
  const response = await extractor.invoke([
    new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
    new HumanMessage(`Exchange:\n${exchangeText}\n\nReturn JSON only.`),
  ]);
  const raw = typeof response?.content === 'string'
    ? response.content
    : Array.isArray(response?.content)
      ? response.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
      : '';
  return parseFactsJson(raw);
}

function clip(text, max = MAX_CONTENT_CHARS) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function messagesToContent(messages) {
  if (typeof messages === 'string') return clip(messages);
  if (!Array.isArray(messages)) return '';
  return clip(
    messages
      .map((m) => `${String(m.role || 'user').toUpperCase()}: ${String(m.content || '').trim()}`)
      .filter((line) => line.includes(': ') && !line.endsWith(': '))
      .join('\n')
  );
}

function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

async function embed(text) {
  const embedder = getEmbedder();
  if (!embedder) return null;
  return embedder.embedQuery(text);
}

async function searchMemories(query, { limit = 5 } = {}) {
  if (!isMemoryEnabled()) return [];
  try {
    const text = clip(query, 800);
    if (!text) return [];
    const queryVec = await embed(text);
    if (!queryVec) return [];

    const rows = await all(
      'SELECT id, content, embedding, metadata, created_at FROM coach_memories ORDER BY created_at DESC LIMIT 500'
    );
    if (!rows.length) return [];

    return rows
      .map((row) => {
        let vec;
        try { vec = JSON.parse(row.embedding); } catch { return null; }
        if (!Array.isArray(vec)) return null;
        return {
          id: row.id,
          memory: row.content,
          score: cosineSim(queryVec, vec),
          createdAt: row.created_at,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (err) {
    console.warn('[memory] search failed:', err.message);
    return [];
  }
}

async function insertFact(content, metadata) {
  const vec = await embed(content);
  if (!vec) return null;
  const id = crypto.randomUUID();
  await run(
    'INSERT INTO coach_memories (id, content, embedding, metadata) VALUES (?, ?, ?, ?)',
    [id, content, JSON.stringify(vec), metadata ? JSON.stringify(metadata) : null]
  );
  return id;
}

async function addMemory(messages, metadata = {}) {
  if (!isMemoryEnabled()) return null;
  try {
    const exchangeText = messagesToContent(messages);
    if (!exchangeText) return null;

    let facts = null;
    try {
      facts = await extractFacts(exchangeText);
    } catch (err) {
      console.warn('[memory] fact extraction failed, falling back to raw:', err.message);
    }

    const factMeta = { ...(metadata || {}), kind: 'fact' };
    if (Array.isArray(facts)) {
      if (facts.length === 0) return { ids: [], skipped: 'no-durable-facts' };
      const ids = [];
      for (const fact of facts) {
        const id = await insertFact(fact, factMeta);
        if (id) ids.push(id);
      }
      return { ids };
    }

    // Extraction unavailable (no API key) or threw — fall back to raw exchange.
    const id = await insertFact(exchangeText, { ...(metadata || {}), kind: 'raw' });
    return id ? { ids: [id] } : null;
  } catch (err) {
    console.warn('[memory] add failed:', err.message);
    return null;
  }
}

async function getAllMemories() {
  if (!isMemoryEnabled()) return [];
  try {
    const rows = await all(
      'SELECT id, content, metadata, created_at FROM coach_memories ORDER BY created_at DESC'
    );
    return rows.map((row) => ({
      id: row.id,
      memory: row.content,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  } catch (err) {
    console.warn('[memory] getAll failed:', err.message);
    return [];
  }
}

async function deleteMemory(memoryId) {
  if (!isMemoryEnabled() || !memoryId) return false;
  try {
    const result = await run('DELETE FROM coach_memories WHERE id = ?', [memoryId]);
    return result.changes > 0;
  } catch (err) {
    console.warn('[memory] delete failed:', err.message);
    return false;
  }
}

async function deleteAllMemories() {
  if (!isMemoryEnabled()) return false;
  try {
    await run('DELETE FROM coach_memories');
    return true;
  } catch (err) {
    console.warn('[memory] deleteAll failed:', err.message);
    return false;
  }
}

module.exports = {
  isMemoryEnabled,
  searchMemories,
  addMemory,
  getAllMemories,
  deleteMemory,
  deleteAllMemories,
};
