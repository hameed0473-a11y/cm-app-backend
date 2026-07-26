const express = require('express');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const router = express.Router();

// ===============================================================
// ADMIN LOGIN — for the internal admin dashboard only. Unrelated to
// pro user accounts (see routes/web/auth.js for those).
// ===============================================================
router.post('/admin-login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const validUsername = username === process.env.ADMIN_USERNAME;
  const validPassword = password === process.env.ADMIN_PASSWORD;

  if (!validUsername || !validPassword) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });

  res.json({ message: 'Admin login successful', token });
});

module.exports = router;
