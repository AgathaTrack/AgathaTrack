'use strict';

/**
 * Test fixture: builds the round records (`facts.rounds`) that the live engine derives from comments,
 * from the older `review` shape the tests describe (`requestedHash`, `requestedAt`, `assignedTo`,
 * `timedOut`, `ringFailed`, and an optional `verdict`). Production code never calls this.
 */
function roundsFromReview(review = {}, bodyHash = 'h1') {
  if (!review.requestedHash) {
    return [{ tier: 'a', kind: 'spec', hashIn: null, attempts: [{ type: 'cursor-a', nonce: null, startedAt: null, result: 'spec', hashOut: bodyHash }] }];
  }
  const specHash = review.specHash || review.requestedHash;
  const spec = { tier: 'a', kind: 'spec', hashIn: null, attempts: [{ type: review.specAuthor || 'cursor-a', nonce: null, startedAt: null, result: 'spec', hashOut: specHash }] };
  const attempts = (review.timedOut || []).map((type) => ({ type, nonce: null, startedAt: review.requestedAt, result: 'silent', hashOut: null }));
  if (review.assignedTo) {
    const v = review.verdict;
    attempts.push({
      type: review.assignedTo,
      nonce: v?.nonce ?? null,
      startedAt: review.requestedAt,
      result: v ? (v.value === 'up' ? 'green' : 'red') : null,
      hashOut: v?.value === 'down' && v.edit ? v.edit : null,
    });
  }
  return [spec, { tier: 'a', kind: 'review', hashIn: review.requestedHash, attempts }];
}

module.exports = { roundsFromReview };
