const Donation = require('../models/Donation');
const PickupLog = require('../models/PickupLog');
const User = require('../models/User');
const {
  ValidationError,
  AuthorizationError,
  NotFoundError,
} = require('../utils/AppError');
const catchAsync = require('../utils/catchAsync');
const { generateOTP } = require('../utils/cryptoUtils');
const { findBestNGO } = require('../services/matchingService');
const { notify, broadcast } = require('../services/notificationService');
const { assessExpiryRisk } = require('../services/expiryRisk');
const { sendDonationAcceptedEmail, sendOTPEmail, sendDeliveryConfirmationEmail } = require('../services/emailService');
const { sendOTPviaSMS } = require('../services/smsService');
const ERRORS = require('../utils/errorMessages');
const logger = require('../utils/logger');
const { STATUS, ROLE } = require('../utils/constants');

// ── Controllers ────────────────────────────────────

/**
 * POST /api/v1/donations
 * Create a new donation (Donor only).
 */
exports.createDonation = catchAsync(async (req, res, next) => {
  const {
    foodType, category, description, quantity, unit,
    preparedAt, expiryTime, pickupDeadline,
    location, pickupAddress, contactPhone, specialInstructions,
  } = req.body;

  // Inherit city/state from donor profile if not provided
  const city = req.body.city || req.user.city;
  const state = req.body.state || req.user.state;
  const country = req.body.country || req.user.country || 'India';
  const citySlug = req.body.citySlug || req.user.citySlug;
  const stateCode = req.body.stateCode || req.user.stateCode;

  const donation = new Donation({
    donorId: req.user._id,
    foodType,
    category,
    description,
    quantity,
    unit,
    preparedAt: preparedAt || new Date(),
    expiryTime,
    pickupDeadline,
    location,
    pickupAddress,
    contactPhone: contactPhone || req.user.phone,
    specialInstructions,
    city,
    state,
    country,
    citySlug,
    stateCode,
  });

  // Server-side food-safety validation
  const expiryCheck = donation.validateExpiry();
  if (!expiryCheck.valid) {
    return next(new ValidationError(expiryCheck.reason));
  }

  await donation.save();

  // Broadcast to NGOs so they see new donations in real-time
  broadcast('role:ngo', 'new-donation', {
    _id: donation._id,
    foodType: donation.foodType,
    quantity: donation.quantity,
    expiryTime: donation.expiryTime,
    pickupAddress: donation.pickupAddress,
    location: donation.location,
    createdAt: donation.createdAt,
  });

  // Auto-match: run matching engine and notify top NGO
  const matches = await findBestNGO(donation._id);
  if (matches.length > 0) {
    const topNGO = matches[0];
    await notify({
      recipientId: topNGO.ngoId,
      type: 'new_donation_nearby',
      title: 'New Donation Available',
      message: `${donation.foodType} (${donation.quantity} ${donation.unit}) — ${topNGO.distanceKm}km away`,
      data: { donationId: donation._id },
    });
  }

  res.status(201).json({
    status: 'success',
    data: { donation, matchedNGOs: matches.length },
  });
});

/**
 * GET /api/v1/donations
 * List donations with filtering, pagination.
 */
exports.getDonations = catchAsync(async (req, res) => {
  const { status, category, city, citySlug, stateCode, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (category) filter.category = category;
  if (citySlug) {
    filter.citySlug = citySlug;
  } else if (city) {
    filter.pickupAddress = { $regex: city, $options: 'i' };
  }
  if (stateCode) filter.stateCode = stateCode;

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const [donations, total] = await Promise.all([
    Donation.find(filter)
      .populate('donorId', 'name organizationName')
      .populate('acceptedBy', 'name organizationName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    Donation.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: donations.length,
    total,
    page: parseInt(page, 10),
    pages: Math.ceil(total / parseInt(limit, 10)),
    data: { donations },
  });
});

/**
 * GET /api/v1/donations/nearby?lat=...&lng=...&radius=5
 * Geo-query for available donations near a point.
 */
exports.getNearbyDonations = catchAsync(async (req, res, next) => {
  const { lat, lng, radius = 5 } = req.query;

  if (!lat || !lng) {
    return next(new ValidationError(ERRORS.MISSING_COORDINATES));
  }

  const donations = await Donation.find({
    status: STATUS.AVAILABLE,
    expiryTime: { $gt: new Date() },
    location: {
      $nearSphere: {
        $geometry: {
          type: 'Point',
          coordinates: [parseFloat(lng), parseFloat(lat)],
        },
        $maxDistance: parseFloat(radius) * 1000, // km → meters
      },
    },
  })
    .populate('donorId', 'name organizationName phone')
    .limit(50);

  res.status(200).json({
    status: 'success',
    results: donations.length,
    data: { donations },
  });
});

/**
 * GET /api/v1/donations/:id
 */
exports.getDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id)
    .populate('donorId', 'name organizationName phone')
    .populate('acceptedBy', 'name organizationName phone');

  if (!donation) {
    return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));
  }

  res.status(200).json({
    status: 'success',
    data: { donation },
  });
});

/**
 * GET /api/v1/donations/my-donations
 * Donor-only: list own donations.
 */
exports.getMyDonations = catchAsync(async (req, res) => {
  const donations = await Donation.find({ donorId: req.user._id })
    .populate('acceptedBy', 'name organizationName')
    .sort({ createdAt: -1 });

  res.status(200).json({
    status: 'success',
    results: donations.length,
    data: { donations },
  });
});

/**
 * PUT /api/v1/donations/:id/accept
 * NGO accepts a donation.
 */
exports.acceptDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);

  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  if (!donation.canTransitionTo(STATUS.ACCEPTED)) {
    return next(
      new ValidationError(ERRORS.INVALID_STATUS_TRANSITION(donation.status))
    );
  }

  // Check expiry safety margin
  const minsUntilExpiry = (new Date(donation.expiryTime) - Date.now()) / 60000;
  if (minsUntilExpiry < 15) {
    return next(new ValidationError(ERRORS.TOO_CLOSE_TO_EXPIRY));
  }

  // Update donation
  donation.status = STATUS.ACCEPTED;
  donation.acceptedBy = req.user._id;
  donation.acceptedAt = new Date();
  await donation.save();

  // Create pickup log with OTP
  const pickupLog = await PickupLog.create({
    donationId: donation._id,
    ngoId: req.user._id,
    donorId: donation.donorId,
    pickupOTP: generateOTP(4),
  });

  // Notify donor
  await notify({
    recipientId: donation.donorId.toString(),
    type: 'donation_accepted',
    title: 'Donation Accepted',
    message: `${req.user.name} has accepted your donation "${donation.foodType}".`,
    data: { donationId: donation._id },
  });

  // Send email to donor with OTP and acceptance info
  const donor = await User.findById(donation.donorId);
  if (donor) {
    sendDonationAcceptedEmail(donor, req.user, donation).catch((err) => logger.error('Email send failed:', err.message));
    sendOTPEmail(donor, donation, pickupLog.pickupOTP).catch((err) => logger.error('Email send failed:', err.message));
    // Also send OTP via SMS if donor has a phone number and SMS is configured
    sendOTPviaSMS(donor.phone, pickupLog.pickupOTP).catch((err) => logger.error('SMS send failed:', err.message));
  }

  // Emit to donation room for any listeners
  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: STATUS.ACCEPTED,
    acceptedBy: req.user._id,
  });

  res.status(200).json({
    status: 'success',
    data: { donation, pickupLog },
  });
});

/**
 * PUT /api/v1/donations/:id/pickup
 * NGO marks donation as picked up (requires OTP verification).
 */
exports.pickupDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  if (!donation.canTransitionTo(STATUS.PICKED_UP)) {
    return next(
      new ValidationError(ERRORS.INVALID_STATUS_TRANSITION(donation.status))
    );
  }

  // Verify the NGO is the one who accepted
  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    return next(new AuthorizationError(ERRORS.ONLY_ACCEPTING_NGO));
  }

  // OTP verification
  const { otp } = req.body;
  const pickupLog = await PickupLog.findOne({
    donationId: donation._id,
    ngoId: req.user._id,
    status: 'in_progress',
  }).select('+pickupOTP');

  if (!pickupLog) return next(new NotFoundError(ERRORS.PICKUP_LOG_NOT_FOUND));

  if (pickupLog.pickupOTP !== otp) {
    return next(new ValidationError(ERRORS.INVALID_OTP));
  }

  // Update pickup log
  pickupLog.pickupTime = new Date();
  pickupLog.otpVerified = true;
  pickupLog.status = 'picked_up';
  await pickupLog.save();

  // Update donation
  donation.status = STATUS.PICKED_UP;
  donation.pickedUpAt = new Date();
  await donation.save();

  // Notify donor
  await notify({
    recipientId: donation.donorId.toString(),
    type: 'pickup_confirmed',
    title: 'Food Picked Up',
    message: `Your donation "${donation.foodType}" has been picked up.`,
    data: { donationId: donation._id },
  });

  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: STATUS.PICKED_UP,
  });

  res.status(200).json({
    status: 'success',
    data: { donation, pickupLog },
  });
});

/**
 * PUT /api/v1/donations/:id/deliver
 * NGO marks donation as delivered.
 */
exports.deliverDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  if (!donation.canTransitionTo(STATUS.DELIVERED)) {
    return next(
      new ValidationError(ERRORS.INVALID_STATUS_TRANSITION(donation.status))
    );
  }

  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    return next(new AuthorizationError(ERRORS.ONLY_ACCEPTING_NGO));
  }

  const { beneficiaryCount, deliveryNotes } = req.body;

  // Update pickup log
  const pickupLog = await PickupLog.findOne({
    donationId: donation._id,
    ngoId: req.user._id,
  });

  if (pickupLog) {
    pickupLog.deliveryTime = new Date();
    pickupLog.status = 'delivered';
    pickupLog.beneficiaryCount = beneficiaryCount || 0;
    pickupLog.deliveryNotes = deliveryNotes || '';
    await pickupLog.save();
  }

  // Update donation
  donation.status = STATUS.DELIVERED;
  donation.deliveredAt = new Date();
  await donation.save();

  // Update NGO reliability score (clamped to 0-100)
  await User.findByIdAndUpdate(req.user._id, [
    { $set: { reliabilityScore: { $min: [100, { $add: ['$reliabilityScore', 2] }] } } },
  ]);

  // Notify donor
  await notify({
    recipientId: donation.donorId.toString(),
    type: 'delivery_confirmed',
    title: 'Delivery Confirmed',
    message: `Your donation "${donation.foodType}" has been delivered to ${beneficiaryCount || 'an unknown number of'} beneficiaries.`,
    data: { donationId: donation._id },
  });

  // Send delivery confirmation email
  const deliveryDonor = await User.findById(donation.donorId);
  if (deliveryDonor) {
    sendDeliveryConfirmationEmail(deliveryDonor, donation, beneficiaryCount).catch((err) => logger.error('Email send failed:', err.message));
  }

  // Notify admins
  const admins = await User.find({ role: ROLE.ADMIN }, '_id');
  for (const admin of admins) {
    await notify({
      recipientId: admin._id.toString(),
      type: 'delivery_confirmed',
      title: 'Donation Delivered',
      message: `Donation #${donation._id} delivered. ${beneficiaryCount || 0} people fed.`,
      data: { donationId: donation._id },
    });
  }

  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: STATUS.DELIVERED,
  });

  res.status(200).json({
    status: 'success',
    data: { donation, pickupLog },
  });
});

/**
 * GET /api/v1/donations/:id/match
 * Get ranked NGO suggestions for a donation (Donor/Admin).
 */
exports.getMatchSuggestions = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  const matches = await findBestNGO(donation._id);

  res.status(200).json({
    status: 'success',
    results: matches.length,
    data: { matches },
  });
});

/**
 * GET /api/v1/donations/:id/risk
 * Expiry risk assessment for a donation.
 */
exports.getExpiryRisk = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  const transportKm = parseFloat(req.query.transportKm) || 0;
  const risk = assessExpiryRisk(donation, transportKm);

  res.status(200).json({
    status: 'success',
    data: { risk },
  });
});

/**
 * PUT /api/v1/donations/:id
 * Edit a donation (Donor only, while still Available).
 */
exports.editDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  if (donation.donorId.toString() !== req.user._id.toString()) {
    return next(new AuthorizationError(ERRORS.ONLY_DONOR_CAN_EDIT));
  }

  if (donation.status !== STATUS.AVAILABLE) {
    return next(new ValidationError(ERRORS.EDIT_ONLY_AVAILABLE));
  }

  const editableFields = [
    'foodType', 'category', 'description', 'quantity', 'unit',
    'expiryTime', 'pickupDeadline', 'pickupAddress', 'contactPhone',
    'specialInstructions', 'location',
  ];

  for (const field of editableFields) {
    if (req.body[field] !== undefined) {
      donation[field] = req.body[field];
    }
  }

  // Re-validate expiry after changes
  if (req.body.expiryTime || req.body.preparedAt || req.body.category) {
    const expiryCheck = donation.validateExpiry();
    if (!expiryCheck.valid) {
      return next(new ValidationError(expiryCheck.reason));
    }
  }

  await donation.save();

  // Broadcast update to NGOs
  broadcast('role:ngo', 'donation-updated', {
    _id: donation._id,
    foodType: donation.foodType,
    quantity: donation.quantity,
    expiryTime: donation.expiryTime,
    pickupAddress: donation.pickupAddress,
  });

  res.status(200).json({
    status: 'success',
    data: { donation },
  });
});

/**
 * PUT /api/v1/donations/:id/cancel
 * Cancel a donation (Donor only, before acceptance).
 */
exports.cancelDonation = catchAsync(async (req, res, next) => {
  const donation = await Donation.findById(req.params.id);
  if (!donation) return next(new NotFoundError(ERRORS.DONATION_NOT_FOUND));

  // Only the donor who created it can cancel
  if (donation.donorId.toString() !== req.user._id.toString()) {
    return next(new AuthorizationError(ERRORS.ONLY_DONOR_CAN_CANCEL));
  }

  if (!donation.canTransitionTo(STATUS.CANCELLED)) {
    return next(
      new ValidationError(ERRORS.CANCEL_ONLY_AVAILABLE(donation.status))
    );
  }

  donation.status = STATUS.CANCELLED;
  await donation.save();

  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: STATUS.CANCELLED,
  });

  res.status(200).json({
    status: 'success',
    data: { donation },
  });
});
