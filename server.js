'use strict';

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { run: runScraper } = require('./scraper');
const { run: runAnalyzer } = require('./analyzer');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3002;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 8 * * *';
const HITL_ENABLED = String(process.env.HITL_ENABLED || 'true').toLowerCase() !== 'false';

['data', 'data/history', 'data/analysis'].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

function createInitialRunState() {
  return {
    status: 'idle',
    isRunning: false,
    isPaused: false,
    pause_reason: null,
    paused_at: null,
    pause_timeout_at: null,
    challenge_url: null,
    manual_actions: [],
    run_source: null,
    startedAt: null,
    currentStep: null,
    progress: null,
    lastMessage: null,
    warnings: [],
    error: null,
  };
}

function createRunController() {
  return {
    pendingActionResolver: null,
    pauseTimeoutTimer: null,
    cancelRequested: false,
  };
}

let runState = createInitialRunState();
let runController = createRunController();

const sseClients = new Set();

function cleanupControllerRuntime() {
  if (runController.pauseTimeoutTimer) {
    clearTimeout(runController.pauseTimeoutTimer);
    runController.pauseTimeoutTimer = null;
  }
  runController.pendingActionResolver = null;
}

function updatePauseState({ paused, reason = null, pauseTimeoutAt = null, challengeUrl = null }) {
  runState.isPaused = !!paused;
  runState.pause_reason = paused ? reason : null;
  runState.paused_at = paused ? new Date().toISOString() : null;
  runState.pause_timeout_at = paused ? (pauseTimeoutAt || null) : null;
  runState.challenge_url = paused ? (challengeUrl || null) : null;
  runState.manual_actions = paused ? ['resume', 'fallback', 'cancel'] : [];
  if (paused) {
    runState.status = 'paused';
  } else if (runState.isRunning) {
    runState.status = 'running';
  }
}

function finishRunStatus(success, err) {
  runState.isRunning = false;
  runState.isPaused = false;
  runState.pause_reason = null;
  runState.paused_at = null;
  runState.pause_timeout_at = null;
  runState.challenge_url = null;
  runState.manual_actions = [];
  runState.currentStep = success ? 'done' : 'error';
  runState.progress = success ? 1 : runState.progress;
  runState.error = err ? err.message : null;
  runState.status = success ? 'done' : 'error';
}

function broadcastSSE(event, data = {}) {
  const payload = JSON.stringify({
    type: event,
    ...data,
    timestamp: new Date().toISOString(),
  });

  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function resolvePendingAction(action) {
  if (!runController.pendingActionResolver) {
    return false;
  }

  const resolver = runController.pendingActionResolver;
  runController.pendingActionResolver = null;

  if (runController.pauseTimeoutTimer) {
    clearTimeout(runController.pauseTimeoutTimer);
    runController.pauseTimeoutTimer = null;
  }

  resolver(action);
  return true;
}

function pushWarning(code, message, extra = {}) {
  runState.warnings = runState.warnings || [];
  runState.warnings.push({
    code: code || 'WARNING',
    message: message || 'Figyelmeztetés',
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function makeProgressCallback() {
  return (event, data = {}) => {
    if (event === 'warning') {
      pushWarning(data.code, data.message, {
        detail_attempted: data.detail_attempted,
        detail_blocked: data.detail_blocked,
        actions: data.actions,
        accepted: data.accepted,
        phase: data.phase,
        url: data.url,
        trigger: data.trigger,
        run_source: data.run_source,
      });
      if (runState.isPaused && data.code === 'DETAIL_BLOCK_FALLBACK_ACTIVE') {
        updatePauseState({ paused: false });
      }
    } else if (event === 'paused') {
      updatePauseState({
        paused: true,
        reason: data.reason || 'bot_check',
        pauseTimeoutAt: data.pause_timeout_at || null,
        challengeUrl: data.challenge_url || null,
      });
      runState.currentStep = 'paused';
      runState.lastMessage = data.message || 'Run paused';
    } else if (event === 'resumed') {
      updatePauseState({ paused: false });
      runState.currentStep = 'resumed';
      runState.lastMessage = data.message || 'Run resumed';
    } else {
      runState.currentStep = event;
      runState.lastMessage = data.message || null;
      runState.progress = data.progress != null ? data.progress : runState.progress;
    }

    broadcastSSE(event, data);
  };
}

async function runFullPipeline(cb, options = {}) {
  return await runScraper(cb, options);
}

async function startAnalyzePipeline() {
  if (!fs.existsSync('data/latest.json')) {
    throw new Error('Nincs scrape eredmény. Először futtasd le a scrapelést!');
  }

  runController = createRunController();
  runState = {
    ...createInitialRunState(),
    status: 'running',
    isRunning: true,
    run_source: 'manual-analyze',
    startedAt: new Date().toISOString(),
    currentStep: 'started',
    lastMessage: 'AI elemzés indítása...',
  };

  broadcastSSE('started', { source: 'manual-analyze', startedAt: runState.startedAt });

  const cb = makeProgressCallback();
  let success = false;
  let error = null;

  try {
    await runAnalyzer(cb);
    success = true;
  } catch (err) {
    error = err;
    console.error('[server] Analyze pipeline error:', err);
    broadcastSSE('error', { message: err.message, source: 'manual-analyze' });
  } finally {
    cleanupControllerRuntime();
    finishRunStatus(success, error);
    if (success) {
      broadcastSSE('done', { finishedAt: new Date().toISOString(), source: 'manual-analyze' });
    }
  }
}

async function startPipeline({ source }) {
  runController = createRunController();
  runState = {
    ...createInitialRunState(),
    status: 'running',
    isRunning: true,
    run_source: source,
    startedAt: new Date().toISOString(),
    currentStep: 'started',
    lastMessage: source === 'cron' ? 'Automatikus napi scrape indítása...' : 'Indítás...',
  };

  broadcastSSE('started', { source, startedAt: runState.startedAt });

  const cb = makeProgressCallback();
  let success = false;
  let error = null;

  try {
    await runFullPipeline(cb, {
      runSource: source,
      hitlEnabled: source === 'manual' && HITL_ENABLED,
      isCancelled: () => !!runController.cancelRequested,
      awaitManualAction: source === 'manual' && HITL_ENABLED
        ? async pausePayload => new Promise(resolve => {
          runController.pendingActionResolver = resolve;

          if (runController.pauseTimeoutTimer) {
            clearTimeout(runController.pauseTimeoutTimer);
          }

          const timeoutAtMs = Date.parse(pausePayload.pause_timeout_at || '');
          if (Number.isFinite(timeoutAtMs)) {
            const msLeft = Math.max(0, timeoutAtMs - Date.now());
            runController.pauseTimeoutTimer = setTimeout(() => {
              if (runController.pendingActionResolver) {
                resolvePendingAction('fallback');
              }
            }, msLeft + 50);
          }
        })
        : null,
    });
    success = true;
  } catch (err) {
    error = err;
    console.error(`[server] Pipeline error (${source}):`, err);
    broadcastSSE('error', { message: err.message, source });
  } finally {
    cleanupControllerRuntime();
    finishRunStatus(success, error);
    runController.cancelRequested = false;
    if (success) {
      broadcastSSE('done', { finishedAt: new Date().toISOString(), source });
    }
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  },
}));

app.get('/api/status', (req, res) => {
  res.json({
    ...runState,
    port: PORT,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/api/latest', (req, res) => {
  try {
    const analysisPath = 'data/analysis/latest-analysis.json';
    if (fs.existsSync(analysisPath)) {
      const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
      return res.json(analysis);
    }

    const rawPath = 'data/latest.json';
    if (fs.existsSync(rawPath)) {
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      return res.json({
        analyzed_at: raw.scraped_at,
        total_scraped: raw.total_found,
        topListings: [],
        allPreselected: raw.listings || [],
        listings: raw.listings || [],
        scrape_meta: raw.scrape_meta || null,
      });
    }

    return res.status(404).json({ error: 'Még nincs adat. Kattints a Frissítés gombra!' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const historyDir = 'data/history';
    if (!fs.existsSync(historyDir)) return res.json([]);

    const files = fs.readdirSync(historyDir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''))
      .sort()
      .reverse();

    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:date', (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const analysisPath = `data/analysis/${date}-analysis.json`;
    if (fs.existsSync(analysisPath)) {
      return res.json(JSON.parse(fs.readFileSync(analysisPath, 'utf8')));
    }

    const rawPath = `data/history/${date}.json`;
    if (fs.existsSync(rawPath)) {
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      return res.json({
        analyzed_at: raw.scraped_at,
        total_scraped: raw.total_found,
        topListings: [],
        allPreselected: raw.listings || [],
        listings: raw.listings || [],
        scrape_meta: raw.scrape_meta || null,
      });
    }

    return res.status(404).json({ error: `Nincs adat erre a napra: ${date}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
  if (runState.isRunning) {
    return res.status(409).json({ error: 'Már fut egy scrape folyamat. Kérjük várj.' });
  }

  startPipeline({ source: 'manual' }).catch(err => {
    console.error('[server] Manual pipeline start failed:', err);
  });
  res.json({ status: 'started', run_source: 'manual', startedAt: runState.startedAt });
});

app.post('/api/analyze', (req, res) => {
  if (runState.isRunning) {
    return res.status(409).json({ error: 'Már fut egy folyamat. Kérjük várj.' });
  }

  if (!fs.existsSync('data/latest.json')) {
    return res.status(409).json({ error: 'Nincs scrape eredmény. Először futtasd le a scrapelést!' });
  }

  startAnalyzePipeline().catch(err => {
    console.error('[server] Analyze pipeline start failed:', err);
  });
  res.json({ status: 'started', run_source: 'manual-analyze', startedAt: runState.startedAt });
});

app.post('/api/run/resume', (req, res) => {
  if (!runState.isRunning || !runState.isPaused) {
    return res.status(409).json({ error: 'Nincs paused futás, amit folytatni lehetne.' });
  }
  if (!resolvePendingAction('resume')) {
    return res.status(409).json({ error: 'Nincs aktív várakozó action.' });
  }

  updatePauseState({ paused: false });
  runState.lastMessage = 'Manual resume requested.';
  broadcastSSE('resumed', { message: 'Kezi folytatas kerve a felhasznalotol.' });
  return res.json({ status: 'ok', action: 'resume' });
});

app.post('/api/run/fallback', (req, res) => {
  if (!runState.isRunning || !runState.isPaused) {
    return res.status(409).json({ error: 'Nincs paused futás, amit fallbackra lehetne váltani.' });
  }
  if (!resolvePendingAction('fallback')) {
    return res.status(409).json({ error: 'Nincs aktív várakozó action.' });
  }

  updatePauseState({ paused: false });
  pushWarning('DETAIL_BLOCK_FALLBACK_ACTIVE', 'Kézi fallback kérve paused állapotban.');
  broadcastSSE('warning', {
    code: 'DETAIL_BLOCK_FALLBACK_ACTIVE',
    message: 'Kézi fallback kérve paused állapotban.',
    run_source: runState.run_source,
    trigger: 'manual_fallback',
  });
  return res.json({ status: 'ok', action: 'fallback' });
});

app.post('/api/run/cancel', (req, res) => {
  if (!runState.isRunning) {
    return res.status(409).json({ error: 'Nincs aktív futás.' });
  }

  runController.cancelRequested = true;
  if (runState.isPaused) {
    resolvePendingAction('cancel');
    updatePauseState({ paused: false });
  }

  pushWarning('RUN_CANCEL_REQUESTED', 'A futás leállítása kérve.');
  broadcastSSE('warning', {
    code: 'RUN_CANCEL_REQUESTED',
    message: 'A futás leállítása kérve.',
    run_source: runState.run_source,
  });
  return res.json({ status: 'ok', action: 'cancel' });
});

app.get('/api/run/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'state', ...runState, timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

cron.schedule(CRON_SCHEDULE, async () => {
  console.log('[cron] Napi scrape indítása:', new Date().toISOString());

  if (runState.isRunning) {
    console.log('[cron] Kihagyva - már fut egy folyamat');
    return;
  }

  await startPipeline({ source: 'cron' });
}, { timezone: 'Europe/Budapest' });

app.listen(PORT, () => {
  console.log('\n========================================');
  console.log(`  Ingatlan AI szerver fut: http://localhost:${PORT}`);
  console.log(`  Cron ütemezés: ${CRON_SCHEDULE} (Europe/Budapest)`);
  console.log('========================================\n');
});
