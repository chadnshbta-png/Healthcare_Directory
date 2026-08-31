/**
 * Directory lifecycle — which professionals the register still lists.
 * ---------------------------------------------------------------------------
 * ScrapeFlow never DELETES a professional. When a complete DHA scan stops
 * returning an id, the sweep stamps `Doctor.removedAt` and keeps the row, so
 * the history survives and a reappearance can clear the flag. That makes the
 * Doctor table a superset of the register:
 *
 *     Doctor rows            = every professional ever seen
 *     removedAt IS NULL      = ACTIVE — still listed by DHA today
 *     removedAt IS NOT NULL  = REMOVED — de-listed, retained for audit
 *
 * The Directory publishes the register as it stands, so it exports the ACTIVE
 * set only. A removed professional must not appear as a searchable record, and
 * must not be counted towards any facility — their relationship rows are still
 * in DoctorFacility and would otherwise silently inflate every facility figure.
 *
 * This module is the single definition of "active", shared by the exporter, the
 * profile exporter and the reconciler. Sharing it is the point: if the export
 * and the check that validates the export disagreed about who counts, the
 * reconciler would happily pass a dataset that is wrong.
 *
 * Databases that predate the lifecycle columns have no `removedAt`. Those are
 * treated as all-active and SAY SO through `source`, rather than failing or
 * silently filtering on a column that does not exist.
 */

/** @param {import('node:sqlite').DatabaseSync} db */
export function lifecycle(db) {
  const hasColumn = db
    .prepare('pragma table_info(Doctor)')
    .all()
    .some((c) => c.name === 'removedAt');

  const total = db.prepare('select count(*) c from Doctor').get().c;
  const removed = hasColumn
    ? db.prepare('select count(*) c from Doctor where removedAt is not null').get().c
    : 0;

  return {
    /** 'doctor_removed_at' when the lifecycle is tracked, 'none' otherwise. */
    source: hasColumn ? 'doctor_removed_at' : 'none',
    tracked: hasColumn,
    totalDoctors: total,
    activeDoctors: total - removed,
    removedDoctors: removed,

    /** Predicate over a Doctor row aliased as `alias`. */
    doctor: (alias = 'd') => (hasColumn ? `${alias}.removedAt is null` : '1 = 1'),

    /**
     * Predicate over any table carrying a `doctorId`, e.g. DoctorFacility or
     * DoctorLicenceType. Keeps a removed professional's rows out of counts
     * without touching the rows themselves.
     */
    viaDoctorId: (alias) =>
      hasColumn
        ? `exists (select 1 from Doctor _life where _life.id = ${alias}.doctorId and _life.removedAt is null)`
        : '1 = 1',

    /** One line for the run log, so every tool states which set it read. */
    describe() {
      return this.tracked
        ? `active ${this.activeDoctors.toLocaleString()} of ${this.totalDoctors.toLocaleString()} ` +
          `(${this.removedDoctors.toLocaleString()} removed, excluded)`
        : `no removedAt column — all ${this.totalDoctors.toLocaleString()} treated as active`;
    },
  };
}
