import mongoose from 'mongoose';

// Who changed what, and when. Old entries expire automatically after 180 days (TTL index).
const auditSchema = new mongoose.Schema(
  {
    actor: { id: Number, name: String, role: String },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: String,
    details: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
auditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);

/** Fire-and-forget audit entry; logging must never break the request. */
export function audit(user, action, entity, entityId, details) {
  AuditLog.create({
    actor: user ? { id: user.id, name: user.name, role: user.role } : undefined,
    action,
    entity,
    entityId: entityId != null ? String(entityId) : undefined,
    details,
  }).catch(() => {});
}
