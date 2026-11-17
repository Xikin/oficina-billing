import { vi, beforeEach } from 'vitest';

process.env.JWT_SECRET = 'test-secret-key-min-32-chars-long!!';
process.env.JWT_CLIENTE_SECRET = 'test-cliente-secret-min-32-chars-long!!';
process.env.MONGODB_URI = 'mongodb://localhost:27017';
process.env.NODE_ENV = 'test';

beforeEach(() => vi.resetAllMocks());
