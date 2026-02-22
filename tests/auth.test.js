/**
 * FoodBridge Authentication — Integration Tests (Simplified Auth)
 *
 * Covers: register, login, getMe, logout, updateProfile.
 * Uses mongodb-memory-server for isolation.
 *
 * Run:  npm test -- tests/auth.test.js
 */

/* ──────────────────────────────────────────────────────────────
 *  1. SET ENVIRONMENT VARIABLES **BEFORE** any app code loads
 * ──────────────────────────────────────────────────────────── */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  'testsecret1234567890123456789012345678901234567890';
process.env.JWT_EXPIRES_IN = '1h';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX = '10000';

/* ──────────────────────────────────────────────────────────────
 *  2. IMPORTS
 * ──────────────────────────────────────────────────────────── */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const crypto = require('crypto');

/* ──────────────────────────────────────────────────────────────
 *  3. SHARED STATE
 * ──────────────────────────────────────────────────────────── */

let mongoServer;
let app;

const TEST_PASSWORD = 'Qw3rty@Safe!789';

function testUser(overrides = {}) {
  return {
    name: 'Test Donor',
    email: `donor-${crypto.randomBytes(4).toString('hex')}@example.com`,
    password: TEST_PASSWORD,
    role: 'donor',
    ...overrides,
  };
}

/**
 * Register + login a fresh user.
 * Returns { user, token }.
 */
async function registerAndLogin(overrides = {}) {
  const data = testUser(overrides);

  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send(data)
    .expect(201);

  return {
    user: regRes.body.user,
    token: regRes.body.token,
    credentials: data,
  };
}

/* ──────────────────────────────────────────────────────────────
 *  4. TEST LIFECYCLE
 * ──────────────────────────────────────────────────────────── */

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  // Mock email service to prevent real SMTP
  jest.mock('../services/emailService', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    sendDonationAcceptedEmail: jest.fn().mockResolvedValue(true),
    sendOTPEmail: jest.fn().mockResolvedValue(true),
    sendDeliveryConfirmationEmail: jest.fn().mockResolvedValue(true),
    sendNGOVerifiedEmail: jest.fn().mockResolvedValue(true),
    getSmtpStatus: jest.fn().mockReturnValue('ok (mock)'),
  }));

  app = require('../app');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

/* ──────────────────────────────────────────────────────────────
 *  5. TESTS
 * ──────────────────────────────────────────────────────────── */

describe('POST /api/v1/auth/register', () => {
  it('should register a new donor and return token + user', async () => {
    const data = testUser();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(data.email);
    expect(res.body.user.role).toBe('donor');
    expect(res.body.user.id).toBeDefined();
  });

  it('should register a new NGO', async () => {
    const data = testUser({ role: 'ngo', name: 'Test NGO' });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe('ngo');
  });

  it('should reject duplicate email with 409', async () => {
    const data = testUser();
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(409);

    expect(res.body.detail).toMatch(/already exists/i);
  });

  it('should reject admin self-registration with 400 (invalid role)', async () => {
    const data = testUser({ role: 'admin' });
    await request(app).post('/api/v1/auth/register').send(data).expect(400);
  });

  it('should reject missing required fields', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com' })
      .expect(400);
  });

  it('should reject password shorter than 8 chars', async () => {
    const data = testUser({ password: 'short' });
    await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(400);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('should login and return token + user', async () => {
    const data = testUser();
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: data.password })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(data.email);
  });

  it('should return 404 for unregistered email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD })
      .expect(404);

    expect(res.body.detail).toMatch(/register/i);
  });

  it('should return 401 for wrong password', async () => {
    const data = testUser();
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: 'WrongPassword123!' })
      .expect(401);

    expect(res.body.detail).toMatch(/invalid credentials/i);
  });

  it('should reject missing email', async () => {
    await request(app)
      .post('/api/v1/auth/login')
      .send({ password: TEST_PASSWORD })
      .expect(400);
  });

  it('should reject missing password', async () => {
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com' })
      .expect(400);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('should return current user when authenticated', async () => {
    const { token } = await registerAndLogin();

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.email).toBeDefined();
    // Password should never be in response
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('should return 401 without token', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .expect(401);
  });

  it('should return 401 with invalid token', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalidtoken123')
      .expect(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('should acknowledge logout', async () => {
    const { token } = await registerAndLogin();

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/logged out/i);
  });
});

describe('PUT /api/v1/auth/profile', () => {
  it('should update user profile', async () => {
    const { token } = await registerAndLogin();

    const res = await request(app)
      .put('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name', phone: '+919876543210' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user.name).toBe('Updated Name');
  });

  it('should not allow email change via profile update', async () => {
    const { token, user } = await registerAndLogin();

    const res = await request(app)
      .put('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'hacker@evil.com' })
      .expect(200);

    // Email should remain unchanged (email not in allowedFields)
    expect(res.body.data.user.email).toBe(user.email);
  });

  it('should not allow role change via profile update', async () => {
    const { token } = await registerAndLogin();

    const res = await request(app)
      .put('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' })
      .expect(200);

    expect(res.body.data.user.role).toBe('donor');
  });

  it('should return 401 without token', async () => {
    await request(app)
      .put('/api/v1/auth/profile')
      .send({ name: 'Hacker' })
      .expect(401);
  });
});

describe('JWT Token Validation', () => {
  it('token from register should work for /me', async () => {
    const data = testUser();
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(201);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${regRes.body.token}`)
      .expect(200);
  });

  it('token from login should work for /me', async () => {
    const data = testUser();
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: data.password })
      .expect(200);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .expect(200);
  });

  it('expired/tampered token should return 401', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI1ZjRhMzI1YjAyNjRmYjAwMTdmNTE5NmQiLCJyb2xlIjoiZG9ub3IiLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6MTYwMDAwMDAwMX0.fake')
      .expect(401);
  });
});
