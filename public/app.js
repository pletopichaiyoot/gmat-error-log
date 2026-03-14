const scrapeForm = document.getElementById('scrape-form');
const scrapeStatus = document.getElementById('scrape-status');
const openChromeBtn = document.getElementById('open-chrome-btn');
const sourceSelect = document.getElementById('source-select');
const runSelect = document.getElementById('run-select');
const runSummary = document.getElementById('run-summary');
const sessionsBody = document.getElementById('sessions-body');
const errorsBody = document.getElementById('errors-body');
const topicList = document.getElementById('topic-list');
const difficultyList = document.getElementById('difficulty-list');
const confidenceList = document.getElementById('confidence-list');
const errorFilterForm = document.getElementById('error-filter-form');

let selectedRunId = null;

function setStatus(message, isError = false) {
  scrapeStatus.textContent = message;
  scrapeStatus.classList.toggle('error', isError);
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = String(value);
  el.textContent = label;
  return el;
}

function formatDate(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString();
}

function formatMaybe(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}

function setMetricList(container, rows, labelKey, valueKey) {
  container.innerHTML = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No data yet';
    container.appendChild(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    const right = document.createElement('strong');
    left.textContent = row[labelKey];
    right.textContent = String(row[valueKey]);
    li.append(left, right);
    container.appendChild(li);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function renderSummary(run) {
  runSummary.innerHTML = '';

  const items = [
    ['Run ID', run?.id || '-'],
    ['Sessions', run?.total_sessions || 0],
    ['Questions', run?.total_questions || 0],
    ['Errors', run?.total_errors || 0],
  ];

  for (const [label, value] of items) {
    const div = document.createElement('div');
    div.className = 'summary-item';
    div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    runSummary.appendChild(div);
  }
}

function renderSessions(rows) {
  sessionsBody.innerHTML = '';
  if (!rows.length) {
    sessionsBody.innerHTML = '<tr><td colspan="6">No sessions found for this run.</td></tr>';
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(row.session_date)}</td>
      <td>${formatMaybe(row.subject)}</td>
      <td>${formatMaybe(row.total_q_api)}</td>
      <td>${formatMaybe(row.error_count)}</td>
      <td>${formatMaybe(row.accuracy_pct)}</td>
      <td>${formatMaybe(row.avg_time_sec)}</td>
    `;
    sessionsBody.appendChild(tr);
  }
}

function renderErrors(rows) {
  errorsBody.innerHTML = '';
  if (!rows.length) {
    errorsBody.innerHTML = '<tr><td colspan="10">No error rows match this filter.</td></tr>';
    return;
  }

  for (const row of rows) {
    const openCell = row.question_url
      ? `<a class="open-btn" href="${row.question_url}" target="_blank" rel="noopener noreferrer">Open</a>`
      : '<span class="muted">-</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(row.session_date)}</td>
      <td>${formatMaybe(row.session_external_id)}</td>
      <td>${formatMaybe(row.q_code)}</td>
      <td>${formatMaybe(row.subject)}</td>
      <td>${formatMaybe(row.difficulty)}</td>
      <td>${formatMaybe(row.topic)}</td>
      <td>${formatMaybe(row.my_answer)}</td>
      <td>${formatMaybe(row.correct_answer)}</td>
      <td>${openCell}</td>
      <td>${formatMaybe(row.time_sec)}</td>
    `;
    errorsBody.appendChild(tr);
  }
}

async function loadRuns() {
  const { runs } = await fetchJson('/api/runs');
  runSelect.innerHTML = '';
  runSelect.appendChild(option('', 'All runs (upserted dataset)'));

  if (!runs.length) {
    selectedRunId = null;
    runSelect.value = '';
    renderSummary(null);
    renderSessions([]);
    renderErrors([]);
    setMetricList(topicList, [], 'topic', 'mistakes');
    setMetricList(difficultyList, [], 'difficulty', 'total');
    setMetricList(confidenceList, [], 'confidence', 'wrong_answers');
    return;
  }

  for (const run of runs) {
    const label = `Run ${run.id} | ${new Date(run.extracted_at).toLocaleString()}`;
    runSelect.appendChild(option(run.id, label));
  }

  selectedRunId = null;
  runSelect.value = '';
  renderSummary({
    id: 'All',
    total_sessions: runs.reduce((sum, row) => sum + (row.total_sessions || 0), 0),
    total_questions: runs.reduce((sum, row) => sum + (row.total_questions || 0), 0),
    total_errors: runs.reduce((sum, row) => sum + (row.total_errors || 0), 0),
  });
}

async function loadDashboard() {
  const runQuery = selectedRunId ? `?runId=${selectedRunId}` : '';
  const [sessionsRes, errorsRes, patternsRes, runsRes] = await Promise.all([
    fetchJson(`/api/sessions${runQuery}`),
    fetchJson(`/api/errors${runQuery}`),
    fetchJson(`/api/patterns${runQuery}`),
    fetchJson('/api/runs'),
  ]);

  renderSessions(sessionsRes.sessions || []);
  renderErrors(errorsRes.errors || []);
  setMetricList(topicList, patternsRes.byTopic || [], 'topic', 'mistakes');
  setMetricList(difficultyList, patternsRes.byDifficulty || [], 'difficulty', 'total');
  setMetricList(confidenceList, patternsRes.confidenceMismatch || [], 'confidence', 'wrong_answers');

  if (selectedRunId) {
    const run = (runsRes.runs || []).find((row) => row.id === selectedRunId);
    renderSummary(run || null);
  } else {
    const rows = runsRes.runs || [];
    renderSummary({
      id: 'All',
      total_sessions: rows.reduce((sum, row) => sum + (row.total_sessions || 0), 0),
      total_questions: rows.reduce((sum, row) => sum + (row.total_questions || 0), 0),
      total_errors: rows.reduce((sum, row) => sum + (row.total_errors || 0), 0),
    });
  }
}

async function loadSources() {
  const { sources } = await fetchJson('/api/sources');
  sourceSelect.innerHTML = '';

  for (const source of sources || []) {
    sourceSelect.appendChild(option(source.id, source.label));
  }

  if (!sourceSelect.value && sourceSelect.options.length > 0) {
    sourceSelect.value = sourceSelect.options[0].value;
  }
}

openChromeBtn.addEventListener('click', async () => {
  const form = new FormData(scrapeForm);
  const cdpUrl = form.get('cdpUrl')?.toString().trim() || 'http://127.0.0.1:9222';
  const source = form.get('source')?.toString().trim();

  setStatus('Opening Chrome with remote debugging...');

  try {
    const result = await fetchJson('/api/open-chrome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cdpUrl, source }),
    });

    setStatus(
      `Chrome launched on port ${result.port} for ${result.source}. Log in there, then run scrape.`
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

scrapeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(scrapeForm);

  const payload = {
    source: form.get('source')?.toString().trim(),
    cdpUrl: form.get('cdpUrl')?.toString().trim(),
  };

  setStatus('Scrape running. Keep the GMAT tab open until complete...');

  try {
    const result = await fetchJson('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setStatus(`Run ${result.run.id} saved (${result.source}, since ${result.sinceUsed}). Refreshing...`);
    await loadRuns();
    await loadDashboard();
    setStatus(`Run ${result.run.id} complete.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

runSelect.addEventListener('change', async () => {
  selectedRunId = runSelect.value ? Number(runSelect.value) : null;
  await loadDashboard();
});

errorFilterForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const form = new FormData(errorFilterForm);
  const subject = form.get('subject')?.toString().trim();
  const difficulty = form.get('difficulty')?.toString().trim();
  const topic = form.get('topic')?.toString().trim();

  const params = new URLSearchParams();
  if (selectedRunId) params.set('runId', String(selectedRunId));
  if (subject) params.set('subject', subject);
  if (difficulty) params.set('difficulty', difficulty);
  if (topic) params.set('topic', topic);

  try {
    const query = params.toString();
    const { errors } = await fetchJson(`/api/errors${query ? `?${query}` : ''}`);
    renderErrors(errors || []);
  } catch (error) {
    setStatus(error.message, true);
  }
});

async function boot() {
  try {
    await loadSources();
    await loadRuns();
    await loadDashboard();
    setStatus('Ready. Start by running a scrape.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

boot();
