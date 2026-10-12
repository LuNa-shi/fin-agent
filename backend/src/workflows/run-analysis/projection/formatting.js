export const shortText = (value, maxLength = 160) => {
  if (value == null) return '';
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, maxLength);
};

export function reviewLabel(review) {
  if (!review) return '—';
  if (review.status === 'accepted_with_gaps' || review.acceptedByRoundLimit) return '达轮数上限，带缺口收敛';
  return review.pass ? '通过' : '需补充';
}
