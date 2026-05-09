import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to backend/uploads — stable on server regardless of process.cwd() (PM2/systemd). */
const defaultRoot = path.join(__dirname, '..', '..', 'uploads');

export const UPLOADS_ROOT = process.env.UPLOADS_ROOT
  ? path.resolve(process.env.UPLOADS_ROOT)
  : defaultRoot;

export const COMPANY_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'company');

export function ensureUploadDirs() {
  fs.mkdirSync(COMPANY_UPLOAD_DIR, { recursive: true });
}
