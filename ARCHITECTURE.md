# Smart Food Waste Reduction Platform — System Architecture

---

## 1. High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER (React)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Donor   │  │   NGO    │  │  Admin   │  │  Public Landing   │  │
│  │Dashboard │  │Dashboard │  │Dashboard │  │     Page          │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────────────────┘  │
│       │              │              │                               │
│  ┌────┴──────────────┴──────────────┴────────────────────────────┐  │
│  │              Shared Component Library                         │  │
│  │  (Maps · Notifications · Forms · Tables · Charts)            │  │
│  └──────────────────────┬────────────────────────────────────────┘  │
└─────────────────────────┼──────────────────────────────────────────┘
                          │  HTTPS / WSS
┌─────────────────────────┼──────────────────────────────────────────┐
│                   API GATEWAY / REVERSE PROXY (Nginx)              │
│                   Rate Limiting · SSL Termination · CORS           │
└─────────────────────────┼──────────────────────────────────────────┘
                          │
┌─────────────────────────┼──────────────────────────────────────────┐
│                    SERVER LAYER (Node + Express)                    │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  Auth    │  │ Donation │  │ Matching │  │  Admin/Analytics │   │
│  │ Module   │  │ Module   │  │ Engine   │  │     Module       │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘   │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Socket.io Real-Time Layer                       │   │
│  │  (Donation broadcasts · Pickup status · Notifications)       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Background Job Scheduler (node-cron / Bull)     │   │
│  │  (Expiry checks · Auto-reassign · Analytics aggregation)    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─────────────────────────┼──────────────────────────────────────────┐
│                     DATA LAYER                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐   │
│  │ MongoDB Atlas │  │    Redis     │  │  Cloud Storage (S3 /    │   │
│  │  (Primary DB) │  │  (Sessions,  │  │  Cloudinary for food    │   │
│  │              │  │   Cache,     │  │  images)                │   │
│  │              │  │   Job Queue) │  │                         │   │
│  └──────────────┘  └──────────────┘  └─────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. Role-Based Access Design

### 2.1 User Roles

| Role | Description | Permissions |
|------|-------------|-------------|
| **Donor** | Restaurant, hostel, caterer, event organizer | Create/edit/cancel donations, view own history, view pickup status |
| **NGO** | Verified non-profit or volunteer group | Browse available donations, accept donations, log pickups, mark deliveries |
| **Admin** | Platform operator | Full CRUD on all resources, verify NGOs, view analytics, manage disputes, system config |

### 2.2 Permission Matrix

```
Resource              Donor           NGO             Admin
──────────────────────────────────────────────────────────────
Donations (own)       CRUD            R               CRUD (all)
Donations (others)    -               R + Accept      CRUD (all)
Pickup Logs           R (own)         CRU (own)       CRUD (all)
NGO Profile           -               RU (own)        CRUD (all)
Users                 RU (self)       RU (self)       CRUD (all)
Analytics             Own stats       Own stats       Global
Notifications         R (own)         R (own)         CRU (all)
System Config         -               -               CRUD
```

### 2.3 Auth Flow

```
Register → Email verify → Login → JWT (access 15min + refresh 7d)
                                      │
                              ┌───────┴────────┐
                              │  Role assigned  │
                              │  at register    │
                              └───────┬────────┘
                                      │
                         NGO accounts require admin
                         verification before activation
```

---

## 3. MongoDB Schemas (Mongoose)

### 3.1 User Schema

```
User {
  _id:              ObjectId
  name:             String, required, trim
  email:            String, required, unique, lowercase, indexed
  passwordHash:     String, required
  role:             String, enum: ['donor', 'ngo', 'admin'], required, indexed
  phone:            String, required
  avatar:           String (URL)

  // Donor-specific
  organizationName: String (required if role=donor)
  organizationType: String, enum: ['restaurant', 'hostel', 'caterer', 'event_organizer', 'individual']
  fssaiLicense:     String (food safety license — Indian context, adapt per region)

  // Common address
  address: {
    street:         String
    city:           String, indexed
    state:          String
    pincode:        String
    location: {
      type:         String, enum: ['Point'], default: 'Point'
      coordinates:  [Number]   // [longitude, latitude]
    }
  }

  isVerified:       Boolean, default: false
  isActive:         Boolean, default: true
  emailVerified:    Boolean, default: false
  refreshToken:     String

  createdAt:        Date
  updatedAt:        Date
}

Indexes:
  - { email: 1 }                          unique
  - { role: 1 }
  - { 'address.location': '2dsphere' }
  - { 'address.city': 1, role: 1 }
```

### 3.2 NGO Profile Schema

```
NGOProfile {
  _id:              ObjectId
  userId:           ObjectId, ref: 'User', required, unique
  registrationNumber: String, required
  description:      String
  website:          String
  documents:        [String]  // URLs to verification docs

  operatingCities:  [String], indexed
  serviceRadius:    Number (km), default: 15
  operatingHours: {
    start:          String (HH:mm)
    end:            String (HH:mm)
    daysActive:     [Number] (0=Sun, 6=Sat)
  }

  capacity: {
    maxPickupsPerDay:  Number, default: 10
    vehicleType:       String, enum: ['bike', 'van', 'truck', 'walk']
  }

  // Reliability tracking
  stats: {
    totalAccepted:     Number, default: 0
    totalPickedUp:     Number, default: 0
    totalDelivered:    Number, default: 0
    totalExpired:      Number, default: 0   // accepted but never picked up
    avgPickupTimeMins: Number, default: 0
    reliabilityScore:  Number, default: 50, min: 0, max: 100
  }

  verificationStatus: String, enum: ['pending', 'verified', 'rejected'], default: 'pending'
  verifiedAt:         Date
  verifiedBy:         ObjectId, ref: 'User'

  createdAt:          Date
  updatedAt:          Date
}

Indexes:
  - { userId: 1 }             unique
  - { verificationStatus: 1 }
  - { operatingCities: 1 }
  - { 'stats.reliabilityScore': -1 }
```

### 3.3 Donation Schema

```
Donation {
  _id:              ObjectId
  donorId:          ObjectId, ref: 'User', required, indexed

  foodDetails: {
    title:          String, required, trim
    description:    String
    category:       String, enum: ['cooked_meal', 'raw_ingredients', 'packaged', 'bakery', 'beverages', 'mixed']
    images:         [String] (URLs, max 4)
  }

  quantity: {
    servings:       Number, required, min: 1
    weightKg:       Number
    unit:           String, enum: ['servings', 'kg', 'packets', 'trays']
  }

  // Expiry and safety
  timing: {
    preparedAt:     Date, required
    expiresAt:      Date, required         // donor sets expected expiry
    pickupWindowStart: Date, required      // earliest pickup
    pickupWindowEnd:   Date, required      // latest pickup
  }

  // Geolocation
  pickupAddress: {
    street:         String, required
    city:           String, required
    state:          String
    pincode:        String
    landmark:       String
    location: {
      type:         String, enum: ['Point'], default: 'Point'
      coordinates:  [Number], required    // [lng, lat]
    }
  }

  contactPhone:     String, required
  specialInstructions: String

  // Status lifecycle
  status:           String, enum: ['available','accepted','picked_up','delivered','expired','cancelled'], default: 'available', indexed

  // Assignment
  acceptedBy:       ObjectId, ref: 'User' (NGO)
  acceptedAt:       Date
  reassignCount:    Number, default: 0
  reassignHistory:  [{
    ngoId:          ObjectId, ref: 'User'
    acceptedAt:     Date
    expiredAt:      Date
    reason:         String
  }]

  // Completion
  deliveredAt:      Date
  deliveryProof:    String (image URL)
  feedbackRating:   Number, min: 1, max: 5
  feedbackNote:     String

  createdAt:        Date
  updatedAt:        Date
}

Indexes:
  - { 'pickupAddress.location': '2dsphere' }
  - { status: 1, 'timing.expiresAt': 1 }
  - { donorId: 1, status: 1 }
  - { acceptedBy: 1, status: 1 }
  - { 'pickupAddress.city': 1, status: 1 }
  - { createdAt: -1 }
```

### 3.4 Pickup Log Schema

```
PickupLog {
  _id:              ObjectId
  donationId:       ObjectId, ref: 'Donation', required, indexed
  ngoId:            ObjectId, ref: 'User', required, indexed
  donorId:          ObjectId, ref: 'User', required

  timeline: {
    acceptedAt:     Date, required
    enRouteAt:      Date
    arrivedAt:      Date
    pickedUpAt:     Date
    deliveredAt:    Date
  }

  verification: {
    pickupOTP:      String (4-digit, generated on accept)
    otpVerified:    Boolean, default: false
    pickupPhoto:    String (URL)
    deliveryPhoto:  String (URL)
  }

  delivery: {
    recipientName:  String
    recipientOrg:   String
    beneficiaryCount: Number          // people fed
    deliveryNotes:  String
  }

  status:           String, enum: ['in_progress', 'picked_up', 'delivered', 'failed'], indexed

  failureReason:    String

  createdAt:        Date
  updatedAt:        Date
}

Indexes:
  - { donationId: 1 }
  - { ngoId: 1, status: 1 }
  - { createdAt: -1 }
```

### 3.5 Notification Schema

```
Notification {
  _id:              ObjectId
  recipientId:      ObjectId, ref: 'User', required, indexed
  type:             String, enum: [
                      'new_donation_nearby',
                      'donation_accepted',
                      'pickup_confirmed',
                      'delivery_confirmed',
                      'donation_expired',
                      'donation_reassigned',
                      'ngo_verified',
                      'system_alert'
                    ], required
  title:            String, required
  message:          String, required
  data: {
    donationId:     ObjectId
    link:           String
  }
  isRead:           Boolean, default: false
  readAt:           Date

  createdAt:        Date  (TTL index: auto-delete after 30 days)
}

Indexes:
  - { recipientId: 1, isRead: 1, createdAt: -1 }
  - { createdAt: 1, expireAfterSeconds: 2592000 }   // TTL 30 days
```

---

## 4. Status Lifecycle

```
                     Donor creates
                          │
                          ▼
                    ┌───────────┐
                    │ Available │◄──────────────────────────────┐
                    └─────┬─────┘                               │
                          │                                     │
              NGO accepts │                      Auto-reassign  │
                          ▼                      (if NGO fails) │
                    ┌───────────┐    30-min timeout             │
                    │ Accepted  │──────────────────────────────►│
                    └─────┬─────┘                               │
                          │                                     │
            OTP verified  │                        3 reassigns  │
                          ▼                        exceeded     │
                    ┌───────────┐                        │      │
                    │ Picked Up │                        ▼      │
                    └─────┬─────┘                  ┌─────────┐  │
                          │                        │ Expired  │  │
             NGO delivers │                        └─────────┘  │
                          ▼                                     │
                    ┌───────────┐                                │
                    │ Delivered │                                │
                    └───────────┘                                │
                                                                │
                    ┌───────────┐                                │
                    │ Cancelled │  (Donor cancels before accept) │
                    └───────────┘                                │

  Background job runs every 5 minutes:
    - If status=available AND timing.expiresAt < now → set Expired
    - If status=accepted AND (now - acceptedAt) > 30min AND no pickup → Reassign / Expire
```

---

## 5. REST API Endpoints

### 5.1 Auth Routes — `/api/v1/auth`

```
POST   /register              Public       Create account (donor/ngo)
POST   /login                 Public       Returns access + refresh tokens
POST   /refresh-token         Public       Rotate refresh token
POST   /logout                Authenticated Invalidate refresh token
POST   /forgot-password       Public       Send reset email
POST   /reset-password/:token Public       Reset password
GET    /verify-email/:token   Public       Verify email address
GET    /me                    Authenticated Get current user profile
PUT    /me                    Authenticated Update own profile
```

### 5.2 Donation Routes — `/api/v1/donations`

```
POST   /                      Donor        Create donation
GET    /                      Auth         List donations (filterable)
                                            ?status=available
                                            ?city=mumbai
                                            ?lat=19.07&lng=72.87&radius=10
                                            ?category=cooked_meal
                                            ?page=1&limit=20
GET    /:id                   Auth         Get donation details
PUT    /:id                   Donor/Admin  Update donation (only if available)
DELETE /:id                   Donor/Admin  Cancel donation (soft delete → status=cancelled)
GET    /my-donations          Donor        Donor's own donations
GET    /nearby                NGO          Geo-query nearby available donations
```

### 5.3 Matching Routes — `/api/v1/match`

```
POST   /auto/:donationId      System/Admin Trigger auto-match for a donation
GET    /suggestions/:donationId Admin/Donor View ranked NGO list for a donation
POST   /accept/:donationId     NGO         Accept a donation
POST   /decline/:donationId    NGO         Decline a matched donation
```

### 5.4 Pickup Routes — `/api/v1/pickups`

```
POST   /initiate/:donationId  NGO          Start pickup (generates OTP)
POST   /verify-otp/:pickupId  NGO          Verify pickup OTP at location
PUT    /status/:pickupId      NGO          Update pickup status (en_route, arrived, picked_up)
POST   /deliver/:pickupId     NGO          Mark delivered (with photo + beneficiary count)
GET    /my-pickups             NGO          NGO's pickup history
GET    /:pickupId              Auth         Get pickup details
```

### 5.5 NGO Routes — `/api/v1/ngo`

```
POST   /profile               NGO          Create NGO profile
GET    /profile                NGO          Get own profile
PUT    /profile                NGO          Update profile
GET    /leaderboard            Public       Top NGOs by reliability / meals delivered
```

### 5.6 Admin Routes — `/api/v1/admin`

```
GET    /dashboard              Admin        Aggregate stats
GET    /users                  Admin        List/search users
PUT    /users/:id/status       Admin        Activate / deactivate user
GET    /ngo/pending             Admin        NGOs awaiting verification
PUT    /ngo/:id/verify          Admin        Approve / reject NGO
GET    /donations/analytics     Admin        Donation trends, waste reduction metrics
GET    /reports/city/:city      Admin        Per-city analytics
GET    /reports/export          Admin        CSV / PDF export
```

### 5.7 Notification Routes — `/api/v1/notifications`

```
GET    /                       Auth         Get user notifications (paginated)
PUT    /:id/read               Auth         Mark as read
PUT    /read-all               Auth         Mark all as read
GET    /unread-count            Auth         Unread count (for badge)
```

---

## 6. Intelligent Matching Algorithm

### 6.1 Trigger Points

The matching engine runs when:
1. A donor creates a new donation (proactive push)
2. An NGO browses available donations (reactive pull)
3. A reassignment occurs (auto-match fallback)

### 6.2 Scoring Formula

For each candidate NGO, compute a **match score (0–100)**:

```
Score = (W1 × distanceScore) + (W2 × urgencyScore) + (W3 × reliabilityScore)
        + (W4 × capacityScore) + (W5 × historyScore)

Weights (tunable):
  W1 = 0.30   Distance
  W2 = 0.25   Time urgency
  W3 = 0.25   NGO reliability
  W4 = 0.10   Current capacity
  W5 = 0.10   Past interaction history
```

### 6.3 Component Calculations

**Distance Score (0–100)**
```
Uses MongoDB $geoNear to get distance in km between donation and NGO.

distanceScore = max(0, 100 - (distance_km / serviceRadius * 100))

If distance > NGO.serviceRadius → score = 0 (exclude)
```

**Urgency Score (0–100)**
```
timeLeftMins = (donation.timing.expiresAt - now) in minutes

if timeLeftMins <= 0       → exclude (expired)
if timeLeftMins <= 30      → urgencyScore = 100
if timeLeftMins <= 60      → urgencyScore = 85
if timeLeftMins <= 120     → urgencyScore = 60
if timeLeftMins <= 240     → urgencyScore = 40
else                       → urgencyScore = 20
```

**Reliability Score (0–100)**
```
Directly from NGOProfile.stats.reliabilityScore

Reliability score itself is recalculated after each completed/failed pickup:
  reliabilityScore = (totalDelivered / totalAccepted) * 70
                   + (1 / avgPickupTimeMins) * 30   // normalized
  Clamped to [0, 100]
```

**Capacity Score (0–100)**
```
todayPickups = count of pickups by this NGO today
maxDaily     = NGOProfile.capacity.maxPickupsPerDay

capacityScore = max(0, ((maxDaily - todayPickups) / maxDaily) * 100)

If todayPickups >= maxDaily → score = 0 (exclude)
```

**History Score (0–100)**
```
If this NGO has successfully picked up from this specific donor before:
  historyScore = 80 + (successfulPastPickups * 5)   // max 100
Else:
  historyScore = 50 (neutral)
```

### 6.4 Match Output

```
Input:  donationId
Output: Ranked list of NGOs with scores

[
  { ngoId, score: 87.5, distance: 2.3km, estimatedArrival: "12 mins" },
  { ngoId, score: 74.2, distance: 5.1km, estimatedArrival: "20 mins" },
  ...
]

Top-ranked NGO receives push notification first.
If no response in 5 minutes, next NGO is notified.
After 3 timeouts or explicit declines, donation stays in "available" pool.
```

---

## 7. Real-Time Communication Layer (Socket.io)

### 7.1 Events Architecture

```
Namespace: /donations

  Server → Client Events:
    'new-donation'           Broadcast to NGOs in range when donation created
    'donation-accepted'      Notify donor when NGO accepts
    'donation-status-update' Status change broadcast (picked_up, delivered, expired)
    'donation-reassigned'    Notify new matched NGOs

Namespace: /notifications

  Server → Client Events:
    'notification'           Any new notification for the user
    'unread-count'           Updated unread count

Namespace: /tracking

  Client → Server Events:
    'ngo-location-update'    NGO sends GPS coordinates during active pickup
  Server → Client Events:
    'pickup-location'        Donor sees NGO's live location on map
    'pickup-eta-update'      Updated ETA
```

### 7.2 Room Strategy

```
On connect, each user joins:
  - room: `user:{userId}`          (personal notifications)
  - room: `city:{cityName}`        (city-wide donation broadcasts)
  - room: `donation:{donationId}`  (joined when involved in a specific donation)

NGOs also join:
  - room: `ngo:available`          (general NGO broadcast channel)
```

### 7.3 Authentication

```
Socket handshake includes JWT in auth header.
Middleware validates token before allowing connection.
Invalid/expired tokens → disconnect with error code.
```

---

## 8. Food Safety & Expiry Validation

### 8.1 Validation Rules (Enforced Server-Side)

```
On donation creation:
  1. expiresAt must be > now + 30 minutes      (minimum viable pickup window)
  2. expiresAt must be < preparedAt + 24 hours  (hard safety cap)
  3. pickupWindowEnd must be <= expiresAt
  4. pickupWindowStart must be >= now

On accept:
  1. Remaining time to expiresAt must be > 15 minutes
  2. Distance must be coverable within remaining time (rough estimate)

Category-specific maximum shelf life:
  cooked_meal:     6 hours from preparedAt
  raw_ingredients: 24 hours
  packaged:        defer to expiresAt on package
  bakery:          12 hours
  beverages:       24 hours
```

### 8.2 Background Cron Jobs

```
Job: expiry-checker (runs every 5 minutes)
  - Find donations: status=available AND expiresAt <= now
  - Set status=expired, notify donor

Job: reassign-checker (runs every 5 minutes)
  - Find donations: status=accepted AND (now - acceptedAt) > 30min AND no pickup log
  - If reassignCount < 3: set status=available, run matching engine, increment reassignCount
  - If reassignCount >= 3: set status=expired, notify donor

Job: analytics-aggregator (runs daily at midnight)
  - Aggregate daily stats: donations created, delivered, expired, waste reduction kg
  - Store in DailyAnalytics collection
```

---

## 9. Project Folder Structure

### 9.1 Server (`/server`)

```
server/
├── src/
│   ├── config/
│   │   ├── db.js                  # MongoDB connection
│   │   ├── env.js                 # Environment variable validation (joi/zod)
│   │   ├── cors.js                # CORS configuration
│   │   └── socket.js              # Socket.io initialization
│   │
│   ├── models/
│   │   ├── User.js
│   │   ├── Donation.js
│   │   ├── NGOProfile.js
│   │   ├── PickupLog.js
│   │   ├── Notification.js
│   │   └── DailyAnalytics.js
│   │
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── donation.routes.js
│   │   ├── match.routes.js
│   │   ├── pickup.routes.js
│   │   ├── ngo.routes.js
│   │   ├── notification.routes.js
│   │   └── admin.routes.js
│   │
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── donation.controller.js
│   │   ├── match.controller.js
│   │   ├── pickup.controller.js
│   │   ├── ngo.controller.js
│   │   ├── notification.controller.js
│   │   └── admin.controller.js
│   │
│   ├── services/                  # Business logic (keeps controllers thin)
│   │   ├── auth.service.js
│   │   ├── donation.service.js
│   │   ├── matching.service.js    # Matching algorithm implementation
│   │   ├── pickup.service.js
│   │   ├── notification.service.js
│   │   └── analytics.service.js
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js     # JWT verification
│   │   ├── role.middleware.js     # Role-based access guard
│   │   ├── validate.middleware.js # Request validation (joi/zod schemas)
│   │   ├── rateLimiter.middleware.js
│   │   ├── upload.middleware.js   # Multer + Cloudinary
│   │   └── error.middleware.js    # Global error handler
│   │
│   ├── validators/                # Request validation schemas
│   │   ├── auth.validator.js
│   │   ├── donation.validator.js
│   │   ├── pickup.validator.js
│   │   └── common.validator.js
│   │
│   ├── socket/
│   │   ├── index.js               # Socket.io setup + auth middleware
│   │   ├── donation.handler.js    # Donation namespace handlers
│   │   ├── notification.handler.js
│   │   └── tracking.handler.js
│   │
│   ├── jobs/                      # Background cron jobs
│   │   ├── expiryChecker.js
│   │   ├── reassignChecker.js
│   │   └── analyticsAggregator.js
│   │
│   ├── utils/
│   │   ├── AppError.js            # Custom error class
│   │   ├── catchAsync.js          # Async error wrapper
│   │   ├── apiFeatures.js         # Pagination, filtering, sorting helper
│   │   ├── email.js               # Email transport (nodemailer)
│   │   ├── otp.js                 # OTP generation
│   │   ├── geo.js                 # Geo distance helpers
│   │   └── constants.js
│   │
│   └── app.js                     # Express app setup
│
├── server.js                      # Entry point (app.listen + socket attach)
├── .env.example
├── .eslintrc.js
├── package.json
└── Dockerfile
```

### 9.2 Client (`/client`)

```
client/
├── public/
│   ├── index.html
│   └── favicon.ico
│
├── src/
│   ├── api/                       # Axios instance + API call functions
│   │   ├── axiosInstance.js        # Base URL, interceptors, token refresh
│   │   ├── auth.api.js
│   │   ├── donation.api.js
│   │   ├── pickup.api.js
│   │   ├── ngo.api.js
│   │   ├── admin.api.js
│   │   └── notification.api.js
│   │
│   ├── components/
│   │   ├── common/                # Reusable UI primitives
│   │   │   ├── Button.jsx
│   │   │   ├── Input.jsx
│   │   │   ├── Modal.jsx
│   │   │   ├── Loader.jsx
│   │   │   ├── Badge.jsx
│   │   │   ├── Card.jsx
│   │   │   ├── Table.jsx
│   │   │   ├── Pagination.jsx
│   │   │   └── ProtectedRoute.jsx
│   │   │
│   │   ├── layout/
│   │   │   ├── Navbar.jsx
│   │   │   ├── Sidebar.jsx
│   │   │   ├── Footer.jsx
│   │   │   └── DashboardLayout.jsx
│   │   │
│   │   ├── maps/
│   │   │   ├── DonationMap.jsx        # Leaflet map showing donations
│   │   │   ├── PickupTracker.jsx      # Live NGO tracking
│   │   │   └── LocationPicker.jsx     # Donor address picker
│   │   │
│   │   ├── donations/
│   │   │   ├── DonationCard.jsx
│   │   │   ├── DonationForm.jsx
│   │   │   ├── DonationList.jsx
│   │   │   ├── DonationDetail.jsx
│   │   │   └── DonationFilters.jsx
│   │   │
│   │   ├── pickups/
│   │   │   ├── PickupTimeline.jsx
│   │   │   ├── OTPVerification.jsx
│   │   │   └── DeliveryConfirmation.jsx
│   │   │
│   │   └── notifications/
│   │       ├── NotificationBell.jsx
│   │       └── NotificationList.jsx
│   │
│   ├── pages/
│   │   ├── Landing.jsx
│   │   ├── Login.jsx
│   │   ├── Register.jsx
│   │   ├── ForgotPassword.jsx
│   │   │
│   │   ├── donor/
│   │   │   ├── DonorDashboard.jsx
│   │   │   ├── CreateDonation.jsx
│   │   │   └── DonorHistory.jsx
│   │   │
│   │   ├── ngo/
│   │   │   ├── NGODashboard.jsx
│   │   │   ├── BrowseDonations.jsx
│   │   │   ├── ActivePickups.jsx
│   │   │   └── NGOProfile.jsx
│   │   │
│   │   └── admin/
│   │       ├── AdminDashboard.jsx
│   │       ├── ManageUsers.jsx
│   │       ├── VerifyNGOs.jsx
│   │       └── Analytics.jsx
│   │
│   ├── context/                   # React Context providers
│   │   ├── AuthContext.jsx
│   │   ├── SocketContext.jsx
│   │   └── NotificationContext.jsx
│   │
│   ├── hooks/                     # Custom hooks
│   │   ├── useAuth.js
│   │   ├── useSocket.js
│   │   ├── useDonations.js
│   │   ├── useGeolocation.js
│   │   └── useNotifications.js
│   │
│   ├── utils/
│   │   ├── constants.js
│   │   ├── formatDate.js
│   │   ├── validators.js          # Client-side form validation
│   │   └── statusColors.js        # Status → color mapping
│   │
│   ├── styles/
│   │   ├── globals.css
│   │   └── variables.css
│   │
│   ├── App.jsx
│   ├── Router.jsx                 # React Router config with role guards
│   └── main.jsx
│
├── .env.example
├── vite.config.js
├── tailwind.config.js
├── package.json
└── Dockerfile
```

---

## 10. Security Best Practices

### 10.1 Authentication & Authorization

```
- Passwords hashed with bcrypt (12 salt rounds)
- JWT access tokens: 15-minute expiry, stored in memory (not localStorage)
- Refresh tokens: 7-day expiry, stored in httpOnly secure cookie
- Role-based middleware on every protected route
- NGO accounts require admin verification before operational access
- Email verification required before login
```

### 10.2 Input Validation & Sanitization

```
- All incoming request bodies validated with Joi or Zod schemas
- mongo-sanitize to prevent NoSQL injection ($gt, $ne in queries)
- xss-clean middleware to strip HTML/script tags from inputs
- helmet.js for HTTP security headers (CSP, X-Frame-Options, etc.)
- File uploads: whitelist MIME types (image/jpeg, image/png), max 5MB
- Geolocation coordinates validated: lat ∈ [-90, 90], lng ∈ [-180, 180]
```

### 10.3 Rate Limiting

```
General API:       100 requests / 15 minutes per IP
Auth endpoints:    10 requests / 15 minutes per IP (login, register, forgot-password)
Donation creation: 20 requests / hour per user
Socket connections: 5 concurrent per user
File uploads:      10 / hour per user

Implementation: express-rate-limit + rate-limit-redis (for distributed deployments)
```

### 10.4 Error Handling Strategy

```
Layered approach:

1. Controller layer: catchAsync wrapper catches all async errors
2. Service layer: throws AppError with HTTP status codes
3. Validation layer: Joi/Zod throws before reaching controller
4. Global error handler middleware (final Express middleware):
   - Development: full error stack + message
   - Production: sanitized message, no stack trace
   - Mongoose CastError → 400 "Invalid ID"
   - Mongoose ValidationError → 400 with field-level messages
   - Mongoose 11000 (duplicate key) → 409 "Already exists"
   - JWT errors → 401 "Invalid / expired token"
   - Unhandled errors → 500 "Internal server error" + logged to monitoring

Structured error response:
{
  status: 'error',
  statusCode: 400,
  message: 'Human-readable message',
  errors: [{ field: 'email', message: 'Invalid email' }]  // validation errors
}
```

### 10.5 Additional Security Measures

```
- CORS whitelist: only allow frontend origin(s)
- HTTPS enforced in production
- MongoDB Atlas IP whitelist + SCRAM authentication
- Environment variables via dotenv, never committed
- Sensitive fields excluded from JSON responses (passwordHash, refreshToken)
  via Mongoose toJSON transform
- Request payload size limit: 10KB JSON, 5MB multipart
- Dependency auditing: npm audit in CI pipeline
```

---

## 11. Scalability & Future Architecture

### 11.1 Multi-City Expansion

```
Data model already supports multi-city through:
  - City field on donations and users (indexed)
  - NGO operatingCities array
  - Geospatial queries scoped by city
  - Socket.io rooms per city for targeted broadcasts

Expansion steps:
  1. Add City collection for admin-managed city configs (boundaries, polygon geofence)
  2. City-scoped admin roles (city_admin)
  3. Region-based database sharding (shard key: city + createdAt)
  4. CDN edge caching for static assets per region
```

### 11.2 Microservices Readiness

```
Current monolith is structured as vertical modules (services/ folder) that map
directly to future microservices:

  auth-service        → User management, JWT, sessions
  donation-service    → Donation CRUD, status management
  matching-service    → Scoring engine, assignment logic
  notification-service → Email, push, in-app, SMS
  analytics-service   → Aggregation, reporting, exports
  pickup-service      → Pickup lifecycle, OTP, tracking

Communication pattern:
  - Sync: REST between services (via API gateway)
  - Async: RabbitMQ / Redis Streams for events
    (donation.created → matching-service,
     pickup.completed → analytics-service + notification-service)

Each service gets its own MongoDB database in Atlas.
Shared schema definitions published as npm packages.
```

### 11.3 CSR / Government Integration

```
API-first design enables:

  1. Government food safety portal integration
     - Webhook endpoints for FSSAI compliance reporting
     - Automated reports: kg food saved, meals distributed, donors registered

  2. CSR dashboard for corporate donors
     - White-labeled portal for large food chains
     - Tax deduction certificate generation (80G equivalent)
     - Impact metrics: carbon offset, meals funded

  3. Open Data API (read-only, anonymized)
     - Public endpoints for researchers and policymakers
     - Aggregated data: waste reduction by city, trends over time
     - OAuth2 for third-party developer access

  4. Mobile app readiness
     - Same REST + Socket.io API consumed by React Native client
     - Push notifications via Firebase Cloud Messaging
```

### 11.4 Infrastructure Diagram (Production)

```
                        ┌──────────┐
                        │ Cloudflare│
                        │   CDN    │
                        └────┬─────┘
                             │
                        ┌────┴─────┐
                        │ Nginx LB │
                        │ (SSL)    │
                        └────┬─────┘
                             │
                    ┌────────┼────────┐
                    │        │        │
              ┌─────┴──┐┌───┴────┐┌──┴─────┐
              │ Node 1  ││ Node 2 ││ Node 3 │   (PM2 cluster or K8s pods)
              └─────┬───┘└───┬────┘└──┬─────┘
                    │        │        │
              ┌─────┴────────┴────────┴─────┐
              │     Redis Cluster           │
              │  (sessions, cache, pub/sub  │
              │   for Socket.io scaling)    │
              └─────────────┬───────────────┘
                            │
              ┌─────────────┴───────────────┐
              │    MongoDB Atlas Cluster     │
              │  (Primary + 2 Replicas)     │
              │  M10+ tier for production   │
              └─────────────────────────────┘
```

---

## 12. Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Auth tokens | JWT (short-lived) + httpOnly refresh cookie | Stateless auth with secure token rotation |
| Geospatial | MongoDB 2dsphere + Leaflet.js | Native geo queries, no external service dependency |
| Real-time | Socket.io with Redis adapter | Scales horizontally with Redis pub/sub |
| Background jobs | node-cron (start), Bull + Redis (scale) | Simple to start, Bull adds persistence + retries |
| File storage | Cloudinary | Optimized image delivery, transformations, free tier |
| Validation | Zod | TypeScript-friendly, composable, better DX than Joi |
| State management | React Context + useReducer | Sufficient for this scope; swap to Zustand if complexity grows |
| Styling | Tailwind CSS | Rapid UI development, consistent design system |
| API versioning | URL prefix `/api/v1/` | Clean migration path for breaking changes |
| Monitoring | Winston (logging) + Sentry (errors) | Structured logs + real-time error tracking |

---

*Architecture version: 1.0 — Designed for hackathon MVP with production upgrade path.*
