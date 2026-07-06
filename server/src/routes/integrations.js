import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { newId } from '../db/repo.js';
import { requireAuth } from '../middleware/auth.js';
import { invokeLLM } from '../integrations/llm.js';
import { extractDataFromFile } from '../integrations/extract.js';

const router = express.Router();

fs.mkdirSync(config.uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${newId()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/integrations/upload  (multipart, field "file") -> { file_url }
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const base = config.publicBaseUrl || '';
  res.json({ file_url: `${base}/uploads/${req.file.filename}`, filename: req.file.originalname });
});

// POST /api/integrations/invoke-llm
router.post('/invoke-llm', requireAuth, async (req, res, next) => {
  try {
    res.json(await invokeLLM(req.body || {}));
  } catch (e) { next(e); }
});

// POST /api/integrations/extract-file  { file_url, json_schema }
router.post('/extract-file', requireAuth, async (req, res, next) => {
  try {
    res.json(await extractDataFromFile(req.body || {}));
  } catch (e) { next(e); }
});

export default router;
