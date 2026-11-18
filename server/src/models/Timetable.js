import mongoose from 'mongoose';

const { Schema } = mongoose;

const partSchema = new Schema(
  {
    offeringId: { type: String, required: true },
    courseId: { type: String, required: true },
    facultyId: { type: String, required: true },
    roomId: { type: String, default: null },
    size: Number,
  },
  { _id: false },
);

const eventSchema = new Schema(
  {
    id: { type: String, required: true },
    key: { type: String, required: true },
    kind: { type: String, enum: ['offering', 'basket'], required: true },
    basketName: String,
    duration: { type: Number, required: true, min: 1 },
    day: { type: Number, default: null },
    start: { type: Number, default: null },
    sectionIds: [String],
    parts: [partSchema],
    locked: { type: Boolean, default: false },
    editedAt: Date,
  },
  { _id: false },
);

const timetableSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued', index: true },
    progress: {
      phase: { type: String, default: 'queued' },
      percent: { type: Number, default: 0 },
      message: String,
    },
    seed: Number,
    timeLimitSec: Number,
    events: [eventSchema],
    unplaced: [{ _id: false, eventId: String, reason: String }],
    score: {
      hardViolations: { type: Number, default: 0 },
      soft: Number,
      breakdown: Schema.Types.Mixed,
    },
    stats: Schema.Types.Mixed,
    error: String,
    validationErrors: Schema.Types.Mixed,
    // Snapshot of the input (embedding instead of referencing, see db/mongo.js).
    problem: { type: Schema.Types.Mixed, required: true },
    published: { type: Boolean, default: false },
    publishedAt: Date,
    createdBy: { id: Number, name: String },
    editCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

timetableSchema.index({ createdAt: -1 });
timetableSchema.index({ published: 1, publishedAt: -1 });

// Virtual: share of classes that were placed.
timetableSchema.virtual('placedPercent').get(function placedPercent() {
  if (!this.events?.length) return 0;
  return Math.round((this.events.filter((e) => e.day !== null).length / this.events.length) * 100);
});

// Static helper used by students/faculty: the timetable currently in force.
timetableSchema.statics.findPublished = function findPublished() {
  return this.findOne({ published: true, status: 'done' }).sort({ publishedAt: -1 });
};

timetableSchema.set('toJSON', { virtuals: true, versionKey: false });

export const Timetable = mongoose.model('Timetable', timetableSchema);
