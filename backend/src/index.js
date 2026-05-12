import 'dotenv/config';
import { buildApp } from './app.js';
import { connectDb } from './config/db.js';

const port = Number.parseInt(process.env.PORT || '5000', 10);
const uri = process.env.MONGODB_URI_OVERRIDE || process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required. Copy backend/.env.example to backend/.env');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required. Copy backend/.env.example to backend/.env');
  process.exit(1);
}
await connectDb(uri);
// eslint-disable-next-line no-console
console.log('MongoDB connected');
const app = buildApp();
app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://0.0.0.0:${port}`);
});
