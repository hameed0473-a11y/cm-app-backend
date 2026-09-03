const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes'); // resolves to ./routes/index.js
const { runRolloverForAllUsers } = require('./utils/rolloverEngine');

const app = express();

// ---------------------------------------------------------------
// SECURITY HEADERS
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
});

// ---------------------------------------------------------------
// CORS — only allow your domains
// ---------------------------------------------------------------
const allowedOrigins = [
  'https://aftechs.in',
  'https://api.aftechs.in',
  'https://cm.aftechs.in',
  'capacitor://localhost',
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Capacitor Android sends null origin)
    if (!origin) return callback(null, true);
    // Allow localhost variants (dev + Capacitor) and GitHub Codespace previews
    if (
      origin.includes('localhost') ||
      origin.includes('capacitor://') ||
      origin.includes('.app.github.dev')
    ) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Log rejected origins for debugging
    console.log('CORS rejected origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ---------------------------------------------------------------
// BODY SIZE LIMIT — prevent large payload attacks
// Webhook route needs raw body — must be before express.json()
// ---------------------------------------------------------------
app.use('/api/auth/webhook', express.raw({ type: 'application/json' }));
app.use('/api/auth/import-contributors', express.json({ limit: '10mb' }));
app.use('/api/auth/pro', express.json({ limit: '10mb' })); // Pro cloud sync
app.use('/api/auth/pro/sync', express.json({ limit: '10mb' })); // explicit
app.use(express.json({ limit: '50kb' })); // increased from 10kb for safety
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// ---------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ message: 'AFLTech API is running!', status: 'ok' });
});

// ---------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------
app.use('/api/auth', authRoutes);

// ---------------------------------------------------------------
// 404 HANDLER
// ---------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---------------------------------------------------------------
// GLOBAL ERROR HANDLER
// ---------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy violation' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ---------------------------------------------------------------
// GOAL ROLLOVER SCHEDULER — needs no external cron setup. Runs once
// shortly after startup (catching up on anything missed while the
// server was down), then checks every hour whether the calendar day
// has changed and runs once per day if so. Monthly/yearly precision
// doesn't need finer granularity than that — see utils/rolloverEngine.js.
// ---------------------------------------------------------------
let lastRolloverRunDate = null;
const HOUR_MS = 60 * 60 * 1000;

function maybeRunRollover() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr === lastRolloverRunDate) return;
  lastRolloverRunDate = todayStr;
  runRolloverForAllUsers().catch(err => console.error('[rollover] scheduled run failed:', err?.message || err));
}

setTimeout(maybeRunRollover, 30 * 1000); // let the server finish booting first
setInterval(maybeRunRollover, HOUR_MS);
