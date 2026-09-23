const express = require('express');
const app = express();
const PORT = 4000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'demo-app' });
});

app.get('/users', (req, res) => {
  // Simulate a database call with random latency
  const delay = Math.floor(Math.random() * 100) + 10;
  setTimeout(() => {
    res.json({ users: ['alice', 'bob', 'charlie'], latency_ms: delay });
  }, delay);
});

app.get('/error', (req, res) => {
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`Demo app listening on http://localhost:${PORT}`);
});