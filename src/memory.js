require('dotenv').config();

// Disable mem0/PostHog telemetry before any imports
if (/^(0|false|no)$/i.test(String(process.env.MEM0_TELEMETRY || 'false').trim())) {
  process.env.POSTHOG_API_KEY = '';
  process.env.MEM0_TELEMETRY = 'false';
}

const USER_ID = 'gmat-student';

let _memoryInstance = null;
let _initPromise = null;

function isMemoryEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.MEM0_ENABLED || '').trim());
}

function getMemoryInstance() {
  if (!isMemoryEnabled()) return Promise.resolve(null);
  if (_memoryInstance) return Promise.resolve(_memoryInstance);
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { Memory } = await import('mem0ai/oss');

      const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
      if (!apiKey) {
        // eslint-disable-next-line no-console
        console.warn('[memory] OPENAI_API_KEY not set, mem0 disabled');
        return null;
      }

      const model = String(process.env.MEM0_MODEL || 'gpt-4o-mini').trim();

      _memoryInstance = new Memory({
        version: 'v1.1',
        embedder: {
          provider: 'openai',
          config: {
            apiKey,
            model: 'text-embedding-3-small',
          },
        },
        vectorStore: {
          provider: 'memory',
          config: {
            collectionName: 'gmat-coach-memories',
            dimension: 1536,
          },
        },
        llm: {
          provider: 'openai',
          config: {
            apiKey,
            model,
          },
        },
        disableHistory: true,
      });

      // eslint-disable-next-line no-console
      console.log(`[memory] mem0 initialized (model=${model})`);
      return _memoryInstance;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[memory] failed to initialize mem0:', err.message);
      _initPromise = null;
      return null;
    }
  })();

  return _initPromise;
}

async function searchMemories(query, { limit = 5 } = {}) {
  if (!isMemoryEnabled()) return [];
  try {
    const mem = await getMemoryInstance();
    if (!mem) return [];
    const results = await mem.search(query, { userId: USER_ID, limit });
    return Array.isArray(results?.results) ? results.results
      : Array.isArray(results) ? results
      : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[memory] search failed:', err.message);
    return [];
  }
}

async function addMemory(messages, metadata = {}) {
  if (!isMemoryEnabled()) return null;
  try {
    const mem = await getMemoryInstance();
    if (!mem) return null;
    const input = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
    const result = await mem.add(input, { userId: USER_ID, metadata });
    return result || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[memory] add failed:', err.message);
    return null;
  }
}

async function getAllMemories() {
  if (!isMemoryEnabled()) return [];
  try {
    const mem = await getMemoryInstance();
    if (!mem) return [];
    const results = await mem.getAll({ userId: USER_ID });
    return Array.isArray(results?.results) ? results.results
      : Array.isArray(results) ? results
      : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[memory] getAll failed:', err.message);
    return [];
  }
}

async function deleteMemory(memoryId) {
  if (!isMemoryEnabled() || !memoryId) return false;
  try {
    const mem = await getMemoryInstance();
    if (!mem) return false;
    await mem.delete(memoryId);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[memory] delete failed:', err.message);
    return false;
  }
}

async function deleteAllMemories() {
  if (!isMemoryEnabled()) return false;
  try {
    const mem = await getMemoryInstance();
    if (!mem) return false;
    await mem.deleteAll({ userId: USER_ID });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[memory] deleteAll failed:', err.message);
    return false;
  }
}

module.exports = {
  isMemoryEnabled,
  getMemoryInstance,
  searchMemories,
  addMemory,
  getAllMemories,
  deleteMemory,
  deleteAllMemories,
};
