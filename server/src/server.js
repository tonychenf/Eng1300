import 'dotenv/config';
import express from 'express';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { adminRouter } from './routes/admin.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/admin', adminRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`MVP server listening on http://localhost:${port}`);
});
