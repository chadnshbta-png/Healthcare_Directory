/**
 * A professional's licence-TYPE set.
 * ---------------------------------------------------------------------------
 * `DoctorLicenceType` is the authoritative membership: a professional can hold
 * several types at once, and the register's own filter buckets sum to more than
 * the population. `Doctor.licenseType` is the search DTO's single PRIMARY value.
 *
 * A professional the membership pass has never covered — anyone registered
 * since the last `sync-licence-types` run — has NO rows in the join table. For
 * those the export falls back to the primary scalar, so a brand-new
 * professional still carries the licence type DHA publishes for them instead of
 * appearing to hold none. That fallback is per PROFESSIONAL, not per database:
 * it applies to the individuals the pass has not reached, while everyone else
 * keeps their authoritative set.
 *
 * This module is the single definition of that rule, shared by the exporter and
 * the reconciler. Sharing it is the point: the reconciler validates the export's
 * licence facet against the source, and if it modelled the fallback differently
 * it would either fail a correct export or pass an incorrect one.
 */

/** The search DTO's codes, expanded to the register's own filter vocabulary. */
export const PRIMARY_LICENCE_LABEL = {
  FTL: 'Full-time License',
  PTL: 'Part-time License',
  REG: 'Registered Only',
  TRL: 'Trainee License',
};

const norm = (s) => (s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim());

/**
 * The licence-type names to publish for one professional.
 *
 * @param {string[]|undefined} membership rows from DoctorLicenceType, if any
 * @param {string|null|undefined} primaryScalar Doctor.licenseType
 * @returns {string[]} de-duplicated labels, authoritative set when one exists
 */
export function licenceNamesFor(membership, primaryScalar) {
  if (membership && membership.length > 0) return membership;
  const scalar = norm(primaryScalar);
  if (scalar === '') return [];
  return [PRIMARY_LICENCE_LABEL[scalar] ?? scalar];
}
