/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         FoodBridge Authentication — Integration Tests        ║
 * ║                                                              ║
 * ║  Covers every auth endpoint with an in-memory MongoDB        ║
 * ║  instance (mongodb-memory-server). No external services      ║
 * ║  required — email sending is mocked at the transport layer.  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  Run:  npm test -- tests/auth.test.js
 *  Or:   npm run test:auth
 */

/* ──────────────────────────────────────────────────────────────
 *  1. SET ENVIRONMENT VARIABLES **BEFORE** any app code loads
 * ──────────────────────────────────────────────────────────── */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  'testsecret1234567890123456789012345678901234567890';
process.env.JWT_REFRESH_SECRET =
  'testrefreshsecret12345678901234567890123456789012';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX = '10000'; // very high — effectively disables the global limiter

/* ──────────────────────────────────────────────────────────────
 *  2. IMPORTS  (order matters — env must be set first)
 * ──────────────────────────────────────────────────────────── */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const crypto = require('crypto');

/* We need otplib to generate valid TOTP codes during 2FA tests */
const { generateSync: generateTOTPCode } = require('otplib');

/* ──────────────────────────────────────────────────────────────
 *  3. SHARED STATE
 * ──────────────────────────────────────────────────────────── */

let mongoServer;
let app; // loaded lazily after MONGO_URI is known

/* Reusable test credentials — avoid words that overlap with the test user name
   ("Test Donor"), since the noPersonalInfo validator rejects passwords containing
   parts of the user's name. */
const TEST_PASSWORD = 'Qw3rty@Safe!789';
const WEAK_PASSWORD = 'weakpassword';
const CHANGED_PASSWORD = 'Ch4ng3d@N0w!55';

function testUser(overrides = {}) {
  return {
    name: 'Test Donor',
    email: `donor-${crypto.randomBytes(4).toString('hex')}@example.com`,
    password: TEST_PASSWORD,
    role: 'donor',
    ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────
 *  Cookie helpers — supertest does not automatically manage
 *  cookies, so we parse Set-Cookie headers manually.
 * ──────────────────────────────────────────────────────────── */

function extractCookies(res) {
  const cookies = {};
  const setCookieHeaders = res.headers['set-cookie'];
  if (!setCookieHeaders) return cookies;

  const arr = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];

  for (const raw of arr) {
    const [pair] = raw.split(';');
    const [name, ...valueParts] = pair.split('=');
    cookies[name.trim()] = valueParts.join('=').trim();
  }
  return cookies;
}

/**
 * Register + verify + login a fresh user in one call.
 * Returns { user, accessToken, refreshToken, csrfToken, cookies }.
 */
async function registerVerifyLogin(overrides = {}) {
  const User = require('../models/User');

  const data = testUser(overrides);

  // 1. Register
  await request(app)
    .post('/api/v1/auth/register')
    .send(data)
    .expect(201);

  // 2. Verify email — generate a fresh token via the model
  const user = await User.findOne({ email: data.email });
  const plainToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  await request(app)
    .get(`/api/v1/auth/verify-email/${plainToken}`)
    .expect(200);

  // 3. Login
  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: data.email, password: data.password })
    .expect(200);

  const cookies = extractCookies(loginRes);

  return {
    user: loginRes.body.data.user,
    accessToken: loginRes.body.accessToken,
    refreshToken: cookies.refreshToken,
    csrfToken: loginRes.body.csrfToken,
    cookies,
    email: data.email,
    password: data.password,
  };
}

/* ──────────────────────────────────────────────────────────────
 *  4. GLOBAL SETUP / TEARDOWN
 * ──────────────────────────────────────────────────────────── */

beforeAll(async () => {
  // Start in-memory MongoDB
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  process.env.MONGO_URI = uri;

  // Connect mongoose before loading the app
  await mongoose.connect(uri);

  // Now load the express app (it reads env on import)
  app = require('../app');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

afterEach(async () => {
  // Clean all collections between tests to avoid cross-contamination
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

/* ══════════════════════════════════════════════════════════════
 *  TEST SUITES
 * ══════════════════════════════════════════════════════════════ */

/* ─────────────── 1. REGISTRATION ─────────────────────────── */

describe('POST /api/v1/auth/register', () => {
  it('should register a donor successfully and return 201', async () => {
    const data = testUser();

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.data.user.email).toBe(data.email);
    expect(res.body.data.user.role).toBe('donor');
    // Password must never be leaked
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('should allow re-registration of unverified email (Case C) with 201', async () => {
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    // Re-register same email (not yet verified) — should succeed with updated details
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...data, name: 'Updated Name' })
      .expect(201);

    expect(res.body.status).toBe('success');
    expect(res.body.data.user.name).toBe('Updated Name');
  });

  it('should reject duplicate verified email with 409', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    // Verify email first
    const user = await User.findOne({ email: data.email });
    const plainToken = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${plainToken}`).expect(200);

    // Attempt to register again — should fail
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(409);

    expect(res.body.message).toMatch(/already exists/i);
  });

  it('should reject a weak password missing uppercase/special', async () => {
    const data = testUser({ password: WEAK_PASSWORD });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data)
      .expect(400);

    expect(res.body.message).toMatch(/validation/i);
  });

  it('should prevent admin self-registration with 403', async () => {
    const data = testUser({ role: 'admin' });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(data);

    // express-validator rejects 'admin' for role before controller sees it
    // The validator says role must be donor or ngo — so expect 400 or 403
    expect([400, 403]).toContain(res.status);
  });

  it('should reject when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'incomplete@example.com' })
      .expect(400);

    expect(res.body.message).toMatch(/validation/i);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});

/* ─────────────── 2. EMAIL VERIFICATION ───────────────────── */

describe('GET /api/v1/auth/verify-email/:token', () => {
  it('should verify email with a valid token', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const user = await User.findOne({ email: data.email });
    const plainToken = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .get(`/api/v1/auth/verify-email/${plainToken}`)
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.message).toMatch(/verified/i);

    // Confirm DB state
    const updatedUser = await User.findOne({ email: data.email });
    expect(updatedUser.isEmailVerified).toBe(true);
  });

  it('should reject an expired verification token with 410 Gone', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const user = await User.findOne({ email: data.email }).select(
      '+emailVerificationToken +emailVerificationExpires'
    );
    const plainToken = user.createEmailVerificationToken();
    // Force the expiry into the past
    user.emailVerificationExpires = new Date(Date.now() - 1000);
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .get(`/api/v1/auth/verify-email/${plainToken}`)
      .expect(410);

    expect(res.body.message).toMatch(/expired/i);
  });

  it('should reject a completely fake token', async () => {
    const fakeToken = crypto.randomBytes(32).toString('hex');

    const res = await request(app)
      .get(`/api/v1/auth/verify-email/${fakeToken}`)
      .expect(400);

    expect(res.body.message).toMatch(/invalid|expired/i);
  });

  it('should reject reuse of a consumed verification token (replay)', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const user = await User.findOne({ email: data.email });
    const plainToken = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });

    // First use — succeeds
    await request(app)
      .get(`/api/v1/auth/verify-email/${plainToken}`)
      .expect(200);

    // Second use — token cleared, must fail
    const res = await request(app)
      .get(`/api/v1/auth/verify-email/${plainToken}`)
      .expect(400);

    expect(res.body.message).toMatch(/invalid|expired/i);
  });
});

/* ─────────────── 3. LOGIN ────────────────────────────────── */

describe('POST /api/v1/auth/login', () => {
  it('should fail before email verification (403)', async () => {
    const data = testUser();
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: data.password })
      .expect(403);

    expect(res.body.message).toMatch(/verify.*email/i);
  });

  it('should login successfully after email verification', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    // Verify email
    const user = await User.findOne({ email: data.email });
    const plainToken = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${plainToken}`).expect(200);

    // Login
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: data.password })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.csrfToken).toBeDefined();

    // Refresh token should be set as a cookie
    const cookies = extractCookies(res);
    expect(cookies.refreshToken).toBeDefined();
  });

  it('should return 401 for wrong password', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    // Verify email so we can attempt login
    const user = await User.findOne({ email: data.email });
    const token = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${token}`).expect(200);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: 'WrongPassword@123!' })
      .expect(401);

    expect(res.body.message).toMatch(/invalid/i);
  });

  it('should return 401 for non-existent email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: TEST_PASSWORD })
      .expect(401);

    expect(res.body.message).toMatch(/invalid/i);
  });

  it('should lock account after 5 failed attempts (423)', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);
    const user = await User.findOne({ email: data.email });
    const token = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${token}`).expect(200);

    // First 4 failed attempts — all return 401
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: data.email, password: 'Wrong@Pass1234!' })
        .expect(401);
    }

    // 5th attempt triggers the lock — returns 423
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: 'Wrong@Pass1234!' })
      .expect(423);

    expect(res.body.message).toMatch(/locked/i);
  });

  it('should block login even with correct password while locked', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);
    const user = await User.findOne({ email: data.email });
    const token = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${token}`).expect(200);

    // Lock the account by brute-forcing
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: data.email, password: 'Wrong@Pass1234!' });
    }

    // Now try with the CORRECT password — still locked
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: data.password })
      .expect(423);

    expect(res.body.message).toMatch(/locked/i);
  });
});

/* ─────────────── 4. PASSWORD RESET ───────────────────────── */

describe('Password Reset Flow', () => {
  describe('POST /api/v1/auth/forgot-password', () => {
    it('should return success for an existing email (no leak)', async () => {
      const User = require('../models/User');
      const data = testUser();

      await request(app).post('/api/v1/auth/register').send(data).expect(201);

      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: data.email })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/if an account exists/i);
    });

    it('should return same success for non-existing email (no enumeration)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/if an account exists/i);
    });
  });

  describe('POST /api/v1/auth/reset-password/:token', () => {
    it('should reset password with a valid token', async () => {
      const User = require('../models/User');
      const data = testUser();

      await request(app).post('/api/v1/auth/register').send(data).expect(201);

      // Verify email first (needed for login later)
      let user = await User.findOne({ email: data.email });
      const verifyToken = user.createEmailVerificationToken();
      await user.save({ validateBeforeSave: false });
      await request(app).get(`/api/v1/auth/verify-email/${verifyToken}`).expect(200);

      // Generate password reset token via the model
      user = await User.findOne({ email: data.email });
      const resetToken = user.createPasswordResetToken();
      await user.save({ validateBeforeSave: false });

      const res = await request(app)
        .post(`/api/v1/auth/reset-password/${resetToken}`)
        .send({ password: CHANGED_PASSWORD })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/reset successful/i);

      // Verify login with new password works
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: data.email, password: CHANGED_PASSWORD })
        .expect(200);

      expect(loginRes.body.accessToken).toBeDefined();
    });

    it('should reject reset with expired token (410 Gone)', async () => {
      const User = require('../models/User');
      const data = testUser();

      await request(app).post('/api/v1/auth/register').send(data).expect(201);

      const user = await User.findOne({ email: data.email });
      const resetToken = user.createPasswordResetToken();
      // Force expiry into the past
      user.passwordResetExpires = new Date(Date.now() - 1000);
      await user.save({ validateBeforeSave: false });

      const res = await request(app)
        .post(`/api/v1/auth/reset-password/${resetToken}`)
        .send({ password: CHANGED_PASSWORD })
        .expect(410);

      expect(res.body.message).toMatch(/expired/i);
    });

    it('should invalidate all sessions after password reset', async () => {
      const User = require('../models/User');
      const Session = require('../models/Session');
      const data = testUser();

      await request(app).post('/api/v1/auth/register').send(data).expect(201);

      // Verify email
      let user = await User.findOne({ email: data.email });
      const verifyToken = user.createEmailVerificationToken();
      await user.save({ validateBeforeSave: false });
      await request(app).get(`/api/v1/auth/verify-email/${verifyToken}`).expect(200);

      // Login to create a session
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: data.email, password: data.password })
        .expect(200);

      const oldAccessToken = loginRes.body.accessToken;

      // Get reset token
      user = await User.findOne({ email: data.email });
      const resetToken = user.createPasswordResetToken();
      await user.save({ validateBeforeSave: false });

      // Reset password
      await request(app)
        .post(`/api/v1/auth/reset-password/${resetToken}`)
        .send({ password: CHANGED_PASSWORD })
        .expect(200);

      // All sessions should be revoked
      const activeSessions = await Session.countDocuments({
        userId: user._id,
        isRevoked: false,
      });
      expect(activeSessions).toBe(0);

      // Old access token should no longer work (tokenVersion bumped)
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${oldAccessToken}`)
        .expect(401);

      expect(meRes.body.message).toMatch(/revoked|log in/i);
    });
  });
});

/* ─────────────── 5. REFRESH TOKEN ────────────────────────── */

describe('POST /api/v1/auth/refresh-token', () => {
  it('should rotate tokens successfully (token rotation)', async () => {
    const { refreshToken } = await registerVerifyLogin();

    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${refreshToken}`)
      .expect(200);

    expect(res.body.accessToken).toBeDefined();

    // New refresh token should be in the cookie
    const newCookies = extractCookies(res);
    expect(newCookies.refreshToken).toBeDefined();
    // The new token must differ from the old one
    expect(newCookies.refreshToken).not.toBe(refreshToken);
  });

  it('should reject old refresh token after rotation (reuse detection)', async () => {
    const { refreshToken } = await registerVerifyLogin();

    // Rotate once — old token becomes invalid
    await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${refreshToken}`)
      .expect(200);

    // Attempt to use the OLD token again
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${refreshToken}`)
      .expect(401);

    expect(res.body.message).toMatch(/invalid|reuse|log in/i);
  });

  it('should return 401 when no refresh cookie is present', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh-token')
      .expect(401);

    expect(res.body.message).toMatch(/no refresh token/i);
  });
});

/* ─────────────── 6. LOGOUT ───────────────────────────────── */

describe('Logout', () => {
  describe('POST /api/v1/auth/logout', () => {
    it('should clear the current session and cookies', async () => {
      const Session = require('../models/Session');
      const { accessToken, refreshToken, csrfToken, user } = await registerVerifyLogin();

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', `refreshToken=${refreshToken}; csrf-token=${csrfToken}`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      expect(res.body.message).toMatch(/logged out/i);

      // Refresh token cookie should be cleared (empty or expired)
      const cookies = extractCookies(res);
      // When cleared, value is empty string or the header contains Expires in the past
      const rawSetCookie = res.headers['set-cookie'];
      const refreshCookieStr = rawSetCookie.find((c) =>
        c.startsWith('refreshToken=')
      );
      // cleared cookie has expired date or empty value
      expect(
        refreshCookieStr.includes('Expires=') ||
        refreshCookieStr.includes('refreshToken=;') ||
        refreshCookieStr.includes('refreshToken= ;')
      ).toBe(true);
    });
  });

  describe('POST /api/v1/auth/logout-all', () => {
    it('should revoke all sessions for the user', async () => {
      const Session = require('../models/Session');
      const User = require('../models/User');
      const { accessToken, refreshToken, csrfToken, email } = await registerVerifyLogin();

      const res = await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', `refreshToken=${refreshToken}; csrf-token=${csrfToken}`)
        .set('x-csrf-token', csrfToken)
        .expect(200);

      expect(res.body.message).toMatch(/all devices/i);

      // Confirm all sessions for this user are revoked
      const user = await User.findOne({ email });
      const activeSessions = await Session.countDocuments({
        userId: user._id,
        isRevoked: false,
      });
      expect(activeSessions).toBe(0);
    });
  });
});

/* ─────────────── 7. CHANGE PASSWORD ──────────────────────── */

describe('POST /api/v1/auth/change-password', () => {
  it('should reject wrong current password', async () => {
    const { accessToken } = await registerVerifyLogin();

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: 'WrongCurrent@123!',
        newPassword: CHANGED_PASSWORD,
        confirmPassword: CHANGED_PASSWORD,
      })
      .expect(401);

    expect(res.body.message).toMatch(/current password/i);
  });

  it('should reject when new password equals current password', async () => {
    const { accessToken, password } = await registerVerifyLogin();

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: password,
        newPassword: password,
        confirmPassword: password,
      });

    // Either 400 from validator (new password must differ) or 400 from controller
    expect([400]).toContain(res.status);
  });

  it('should change password and invalidate other sessions', async () => {
    const Session = require('../models/Session');
    const User = require('../models/User');
    const { accessToken, email, password } = await registerVerifyLogin();

    // Create a second session by logging in again
    const secondLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const secondAccessToken = secondLogin.body.accessToken;

    // Change password from the first session
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        currentPassword: password,
        newPassword: CHANGED_PASSWORD,
        confirmPassword: CHANGED_PASSWORD,
      })
      .expect(200);

    expect(res.body.message).toMatch(/password changed/i);
    // Response should include a new access token (re-issued session)
    expect(res.body.accessToken).toBeDefined();

    // The old second session's access token should now be invalid
    // because tokenVersion was bumped
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${secondAccessToken}`)
      .expect(401);

    expect(meRes.body.message).toMatch(/revoked|log in|changed/i);

    // Login with NEW password should work
    const freshLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: CHANGED_PASSWORD })
      .expect(200);

    expect(freshLogin.body.accessToken).toBeDefined();
  });
});

/* ─────────────── 8. ROLE-BASED ACCESS ────────────────────── */

describe('Role-Based Access Control', () => {
  it('should reject non-admin users on admin routes (403)', async () => {
    const { accessToken } = await registerVerifyLogin({ role: 'donor' });

    const res = await request(app)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(res.body.message).toMatch(/permission/i);
  });

  it('should reject unauthenticated requests to protected routes (401)', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .expect(401);

    expect(res.body.message).toMatch(/authentication|log in/i);
  });

  it('should reject requests with malformed bearer token (401)', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalidtoken123')
      .expect(401);

    expect(res.body.message).toMatch(/invalid|token/i);
  });
});

/* ─────────────── 9. TWO-FACTOR AUTHENTICATION ────────────── */

describe('Two-Factor Authentication (2FA)', () => {
  /**
   * Helper: set up and enable 2FA for a logged-in user.
   * Returns the plain TOTP secret so we can generate codes.
   */
  async function enable2FA(accessToken) {
    // Step 1: Setup — get otpauth URL and plain secret
    const setupRes = await request(app)
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(setupRes.body.data.otpauthUrl).toBeDefined();
    expect(setupRes.body.data.secret).toBeDefined();

    const secret = setupRes.body.data.secret;

    // Step 2: Generate a valid TOTP code and verify setup
    const totpCode = generateTOTPCode({ secret });

    const verifyRes = await request(app)
      .post('/api/v1/auth/2fa/verify-setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ totpCode })
      .expect(200);

    expect(verifyRes.body.message).toMatch(/enabled/i);
    expect(verifyRes.body.data.backupCodes).toBeDefined();
    expect(verifyRes.body.data.backupCodes.length).toBe(10);

    return { secret, backupCodes: verifyRes.body.data.backupCodes };
  }

  it('should return otpauth URL during 2FA setup', async () => {
    const { accessToken } = await registerVerifyLogin();

    const res = await request(app)
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.data.secret).toBeDefined();
    expect(typeof res.body.data.secret).toBe('string');
  });

  it('should enable 2FA after verifying a valid TOTP code', async () => {
    const User = require('../models/User');
    const { accessToken, email } = await registerVerifyLogin();

    const { secret } = await enable2FA(accessToken);

    // Confirm DB state
    const user = await User.findOne({ email }).select('+twoFactorEnabled');
    expect(user.twoFactorEnabled).toBe(true);
  });

  it('should return requiresTwoFactor on login when 2FA is enabled', async () => {
    const { accessToken, email, password } = await registerVerifyLogin();
    await enable2FA(accessToken);

    // Logout and login again — should get 2FA challenge
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(loginRes.body.requiresTwoFactor).toBe(true);
    expect(loginRes.body.twoFactorToken).toBeDefined();
    // Should NOT have accessToken yet
    expect(loginRes.body.accessToken).toBeUndefined();
  });

  it('should reject verify-2fa with invalid TOTP code', async () => {
    const { accessToken, email, password } = await registerVerifyLogin();
    await enable2FA(accessToken);

    // Login to get the twoFactorToken
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const { twoFactorToken } = loginRes.body;

    // Send an invalid TOTP code
    const res = await request(app)
      .post('/api/v1/auth/verify-2fa')
      .send({ twoFactorToken, totpCode: '000000' })
      .expect(401);

    expect(res.body.message).toMatch(/invalid/i);
  });

  it('should complete login with valid TOTP code via verify-2fa', async () => {
    const { accessToken, email, password } = await registerVerifyLogin();
    const { secret } = await enable2FA(accessToken);

    // Login — get 2FA challenge
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const { twoFactorToken } = loginRes.body;

    // Generate a valid TOTP code
    const totpCode = generateTOTPCode({ secret });

    const res = await request(app)
      .post('/api/v1/auth/verify-2fa')
      .send({ twoFactorToken, totpCode })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.data.user).toBeDefined();
  });

  it('should disable 2FA when correct password is provided', async () => {
    const User = require('../models/User');
    const { accessToken, email, password } = await registerVerifyLogin();
    await enable2FA(accessToken);

    const res = await request(app)
      .post('/api/v1/auth/2fa/disable')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password })
      .expect(200);

    expect(res.body.message).toMatch(/disabled/i);

    // Confirm in DB
    const user = await User.findOne({ email }).select('+twoFactorEnabled');
    expect(user.twoFactorEnabled).toBe(false);
  });

  it('should reject 2FA disable with wrong password', async () => {
    const { accessToken } = await registerVerifyLogin();
    await enable2FA(accessToken);

    const res = await request(app)
      .post('/api/v1/auth/2fa/disable')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'WrongPassword@123!' })
      .expect(401);

    expect(res.body.message).toMatch(/invalid password/i);
  });
});

/* ─────────────── 10. SOCKET AUTH (basic import test) ─────── */

describe('Socket Module', () => {
  it('should import the socket initialization module without errors', () => {
    const initSocket = require('../socket/index');
    expect(typeof initSocket).toBe('function');
  });
});

/* ─────────────── SUPPLEMENTARY: Session & Profile ────────── */

describe('GET /api/v1/auth/me', () => {
  it('should return the authenticated user profile', async () => {
    const { accessToken, email } = await registerVerifyLogin();

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.user.email).toBe(email);
    // Sensitive fields must never appear
    expect(res.body.data.user.password).toBeUndefined();
    expect(res.body.data.user.loginAttempts).toBeUndefined();
    expect(res.body.data.user.twoFactorSecret).toBeUndefined();
  });
});

describe('GET /api/v1/auth/sessions', () => {
  it('should list active sessions for authenticated user', async () => {
    const { accessToken } = await registerVerifyLogin();

    const res = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data.sessions).toBeDefined();
    expect(Array.isArray(res.body.data.sessions)).toBe(true);
    expect(res.body.data.activeSessions).toBeGreaterThanOrEqual(1);
  });
});

/* ══════════════════════════════════════════════════════════════
 *  AUDIT-SPECIFIC TESTS
 *  Tests added as part of the signup/verification + auth/JWT audits.
 * ══════════════════════════════════════════════════════════════ */

/* ─── Audit 1: Signup/Verification Edge Cases ──────────────── */

describe('Audit 1 — Signup/Verification Hardening', () => {
  it('should update user details during unverified re-registration (Case C)', async () => {
    const User = require('../models/User');
    const data = testUser();

    // Initial registration
    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    // Re-register with different name and password
    const newPassword = 'N3wSecure@Pass!';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ ...data, name: 'New Name', password: newPassword })
      .expect(201);

    // Verify the DB was updated
    const user = await User.findOne({ email: data.email });
    expect(user.name).toBe('New Name');

    // Verify we can verify with the new token and login with the new password
    const plainToken = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${plainToken}`).expect(200);

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: newPassword })
      .expect(200);

    expect(loginRes.body.accessToken).toBeDefined();
  });

  it('should return 400 for an invalid (never-issued) reset token', async () => {
    const fakeToken = crypto.randomBytes(32).toString('hex');

    const res = await request(app)
      .post(`/api/v1/auth/reset-password/${fakeToken}`)
      .send({ password: CHANGED_PASSWORD })
      .expect(400);

    expect(res.body.message).toMatch(/invalid/i);
  });

  it('should reject consumed reset token on second use', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);

    const user = await User.findOne({ email: data.email });
    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    // First reset — succeeds
    await request(app)
      .post(`/api/v1/auth/reset-password/${resetToken}`)
      .send({ password: CHANGED_PASSWORD })
      .expect(200);

    // Second use of same token — should fail (token consumed)
    const res = await request(app)
      .post(`/api/v1/auth/reset-password/${resetToken}`)
      .send({ password: 'An0ther@Pass!99' })
      .expect(400);

    expect(res.body.message).toMatch(/invalid/i);
  });
});

/* ─── Audit 2: Auth/JWT/Session Edge Cases ─────────────────── */

describe('Audit 2 — Auth/JWT/Session Hardening', () => {
  it('should return 401 for locked account with wrong password (enumeration prevention)', async () => {
    const User = require('../models/User');
    const data = testUser();

    await request(app).post('/api/v1/auth/register').send(data).expect(201);
    const user = await User.findOne({ email: data.email });
    const token = user.createEmailVerificationToken();
    await user.save({ validateBeforeSave: false });
    await request(app).get(`/api/v1/auth/verify-email/${token}`).expect(200);

    // Lock by sending 5 wrong passwords (5th triggers lock)
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: data.email, password: 'Wrong@Pass1234!' });
    }

    // Wrong password on locked account — should get generic 401, NOT 423
    // This prevents attackers from knowing the account is locked
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: data.email, password: 'StillWrong@Pass!' })
      .expect(401);

    expect(res.body.message).toMatch(/invalid/i);
  });

  it('should revoke all sessions on refresh token reuse', async () => {
    const Session = require('../models/Session');
    const User = require('../models/User');
    const { refreshToken, email } = await registerVerifyLogin();

    // Rotate once — old token becomes invalid
    const rotateRes = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${refreshToken}`)
      .expect(200);

    const newCookies = extractCookies(rotateRes);
    const newRefreshToken = newCookies.refreshToken;

    // Reuse the OLD token — triggers reuse detection
    await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${refreshToken}`)
      .expect(401);

    // ALL sessions for this user should now be revoked
    const user = await User.findOne({ email });
    const activeSessions = await Session.countDocuments({
      userId: user._id,
      isRevoked: false,
    });
    expect(activeSessions).toBe(0);

    // Even the legitimately rotated token should be revoked
    const afterReuseRes = await request(app)
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `refreshToken=${newRefreshToken}`)
      .expect(401);

    expect(afterReuseRes.body.message).toMatch(/invalid|reuse|log in/i);
  });

  it('should invalidate access token after logout-all via tokenVersion', async () => {
    const { accessToken, refreshToken, csrfToken } = await registerVerifyLogin();

    // Logout all
    await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', `refreshToken=${refreshToken}; csrf-token=${csrfToken}`)
      .set('x-csrf-token', csrfToken)
      .expect(200);

    // Access token should now be rejected (tokenVersion bumped)
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    expect(meRes.body.message).toMatch(/revoked|log in/i);
  });

  it('should support multi-device sessions', async () => {
    const Session = require('../models/Session');
    const User = require('../models/User');
    const { email, password } = await registerVerifyLogin();

    // Login from "device 2"
    const secondLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(secondLogin.body.accessToken).toBeDefined();

    // Both sessions should be active
    const user = await User.findOne({ email });
    const activeSessions = await Session.countDocuments({
      userId: user._id,
      isRevoked: false,
      expiresAt: { $gt: new Date() },
    });
    expect(activeSessions).toBe(2);
  });

  it('should revoke a specific session without affecting others', async () => {
    const Session = require('../models/Session');
    const User = require('../models/User');
    const creds = await registerVerifyLogin();

    // Create a second session
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: creds.password })
      .expect(200);

    // Get sessions list
    const sessionsRes = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${creds.accessToken}`)
      .expect(200);

    expect(sessionsRes.body.data.activeSessions).toBe(2);

    // Revoke the first session
    const sessionId = sessionsRes.body.data.sessions[0]._id;
    await request(app)
      .delete(`/api/v1/auth/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${creds.accessToken}`)
      .set('Cookie', `refreshToken=${creds.refreshToken}; csrf-token=${creds.csrfToken}`)
      .set('x-csrf-token', creds.csrfToken)
      .expect(200);

    // Should have 1 active session remaining
    const user = await User.findOne({ email: creds.email });
    const remaining = await Session.countDocuments({
      userId: user._id,
      isRevoked: false,
      expiresAt: { $gt: new Date() },
    });
    expect(remaining).toBe(1);
  });
});
