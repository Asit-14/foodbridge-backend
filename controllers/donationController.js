const Donation = require('../models/Donation');
const PickupLog = require('../models/PickupLog');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const catchAsync = require('../utils/catchAsync');
const { findBestNGO } = require('../services/matchingService');
const { notify, broadcast } = require('../services/notificationService');
const { assessExpiryRisk } = require('../services/expiryRisk');
const { sendDonationAcceptedEmail, sendOTPEmail, sendDeliveryConfirmationEmail } = require('../services/emailService');

// ── Helpers ────────────────────────────────────────

/** Generate a 4-digit OTP for pickup verification */
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

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
  });

  // Server-side food-safety validation
  const expiryCheck = donation.validateExpiry();
  if (!expiryCheck.valid) {
    return next(new AppError(expiryCheck.reason, 400));
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
  const { status, category, city, page = 1, limit = 20 } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (category) filter.category = category;
  if (city) filter.pickupAddress = { $regex: city, $options: 'i' };

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
    return next(new AppError('Please provide lat and lng query parameters.', 400));
  }

  const donations = await Donation.find({
    status: 'Available',
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
    return next(new AppError('Donation not found.', 404));
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

  if (!donation) return next(new AppError('Donation not found.', 404));

  if (!donation.canTransitionTo('Accepted')) {
    return next(
      new AppError(`Cannot accept a donation with status "${donation.status}".`, 400)
    );
  }

  // Check expiry safety margin
  const minsUntilExpiry = (new Date(donation.expiryTime) - Date.now()) / 60000;
  if (minsUntilExpiry < 15) {
    return next(new AppError('Donation is too close to expiry to accept safely.', 400));
  }

  // Update donation
  donation.status = 'Accepted';
  donation.acceptedBy = req.user._id;
  donation.acceptedAt = new Date();
  await donation.save();

  // Create pickup log with OTP
  const pickupLog = await PickupLog.create({
    donationId: donation._id,
    ngoId: req.user._id,
    donorId: donation.donorId,
    pickupOTP: generateOTP(),
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
    sendDonationAcceptedEmail(donor, req.user, donation).catch(() => {});
    sendOTPEmail(donor, donation, pickupLog.pickupOTP).catch(() => {});
  }

  // Emit to donation room for any listeners
  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: 'Accepted',
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
  if (!donation) return next(new AppError('Donation not found.', 404));

  if (!donation.canTransitionTo('PickedUp')) {
    return next(
      new AppError(`Cannot pick up a donation with status "${donation.status}".`, 400)
    );
  }

  // Verify the NGO is the one who accepted
  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Only the accepting NGO can pick up this donation.', 403));
  }

  // OTP verification
  const { otp } = req.body;
  const pickupLog = await PickupLog.findOne({
    donationId: donation._id,
    ngoId: req.user._id,
    status: 'in_progress',
  }).select('+pickupOTP');

  if (!pickupLog) return next(new AppError('Pickup log not found.', 404));

  if (pickupLog.pickupOTP !== otp) {
    return next(new AppError('Invalid OTP. Please check with the donor.', 400));
  }

  // Update pickup log
  pickupLog.pickupTime = new Date();
  pickupLog.otpVerified = true;
  pickupLog.status = 'picked_up';
  await pickupLog.save();

  // Update donation
  donation.status = 'PickedUp';
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
    status: 'PickedUp',
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
  if (!donation) return next(new AppError('Donation not found.', 404));

  if (!donation.canTransitionTo('Delivered')) {
    return next(
      new AppError(`Cannot deliver a donation with status "${donation.status}".`, 400)
    );
  }

  if (donation.acceptedBy.toString() !== req.user._id.toString()) {
    return next(new AppError('Only the accepting NGO can mark delivery.', 403));
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
  donation.status = 'Delivered';
  donation.deliveredAt = new Date();
  await donation.save();

  // Update NGO reliability score (simple increment for successful delivery)
  await User.findByIdAndUpdate(req.user._id, {
    $inc: { reliabilityScore: 2 },
  });

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
    sendDeliveryConfirmationEmail(deliveryDonor, donation, beneficiaryCount).catch(() => {});
  }

  // Notify admins
  const admins = await User.find({ role: 'admin' }, '_id');
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
    status: 'Delivered',
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
  if (!donation) return next(new AppError('Donation not found.', 404));

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
  if (!donation) return next(new AppError('Donation not found.', 404));

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
  if (!donation) return next(new AppError('Donation not found.', 404));

  if (donation.donorId.toString() !== req.user._id.toString()) {
    return next(new AppError('Only the donor can edit their donation.', 403));
  }

  if (donation.status !== 'Available') {
    return next(new AppError('Can only edit donations with status "Available".', 400));
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
      return next(new AppError(expiryCheck.reason, 400));
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
  if (!donation) return next(new AppError('Donation not found.', 404));

  // Only the donor who created it can cancel
  if (donation.donorId.toString() !== req.user._id.toString()) {
    return next(new AppError('Only the donor can cancel their donation.', 403));
  }

  if (!donation.canTransitionTo('Cancelled')) {
    return next(
      new AppError(`Cannot cancel a donation with status "${donation.status}". Only Available donations can be cancelled.`, 400)
    );
  }

  donation.status = 'Cancelled';
  await donation.save();

  broadcast(`donation:${donation._id}`, 'donation-status-update', {
    donationId: donation._id,
    status: 'Cancelled',
  });

  res.status(200).json({
    status: 'success',
    data: { donation },
  });
});
