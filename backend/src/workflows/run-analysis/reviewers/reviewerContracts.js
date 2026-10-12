// Reviewer selection belongs to workflow mechanics; Agent definitions own prompts and Tool Use.
export const REVIEWER_TYPES = Object.freeze(['evidence', 'requirements', 'logic']);

export function reviewerContractId(reviewerType) {
  if (!REVIEWER_TYPES.includes(reviewerType)) {
    throw new TypeError(`Unknown reviewer type: ${reviewerType}`);
  }
  return reviewerType === 'requirements' ? 'requirement-reviewer' : `${reviewerType}-reviewer`;
}
