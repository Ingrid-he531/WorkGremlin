'use strict';

/**
 * The council room's **consensus decision** —— pure functions: no IO, no database, no spawning.
 *
 * Why it is split out and written as pure functions: the repo's iron rule is "no fabrication"
 * (docs/requirements.md §1). The easiest place for the council to cross that line is the final
 * "we all agree" step —— letting the model say "we all agree" itself is the cheapest approach and
 * also the most deceptive one. So this does not trust the model's self-report, it only counts
 * **structured votes**; if it cannot count them, it honestly says "no consensus". It lives in its
 * own file so every case can be pinned down by tests.
 *
 * Terminology (uniform across the repo; use the same set elsewhere):
 *   · Seats —— however many floors were picked for this run, that many seats. **Absence is still
 *     attendance**, it is not discounted for failure, otherwise "three participants, two crashed,
 *     the remaining one agrees" would count as consensus.
 *   · Valid vote —— status='ok' and the vote type parses. Unparseable = no position expressed.
 *   · No position expressed (invalid) —— timeout / process failure / unparseable output. **It counts
 *     as neither agreement nor disagreement**, but it does make the round **fail to reach
 *     consensus**: a round where nobody answered cannot be called a deal.
 */

/** The three votes. Abstaining is an **explicit position** ("I do not object, but I do not endorse either"), which is not the same as "no position expressed". */
const VOTES = Object.freeze({
  AGREE: 'agree',
  DISAGREE: 'disagree',
  ABSTAIN: 'abstain',
});

/** The two decision criteria */
const THRESHOLDS = Object.freeze({
  /** Default: no objections + agreement over half + nobody left unanswered */
  UNANIMOUS: 'unanimous',
  /** Majority rules: agree > disagree + nobody left unanswered */
  MAJORITY: 'majority',
});

/**
 * Models hand over vote types in all sorts of shapes; only **explicit** expressions are accepted
 * here, and anything unrecognized is null (no position expressed). Better to judge "no position"
 * than to guess —— guessing wrong would report "did not actually reach a deal" as "deal reached".
 *
 * @param {unknown} raw
 * @returns {'agree'|'disagree'|'abstain'|null}
 */
function normalizeVote(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Chinese / English / common synonyms are all accepted; order matters: check "abstain" before
  // "agree", because a phrasing like "not opposed" contains both the characters for "oppose" and
  // "agree", and mixing the tests would count an abstention as a vote.
  if (/^(abstain|neutral|none|弃权|中立|不表态|无所谓)$/.test(s)) return VOTES.ABSTAIN;
  if (/^(agree|yes|approve|accept|同意|赞成|支持|通过)$/.test(s)) return VOTES.AGREE;
  if (/^(disagree|no|reject|oppose|反对|不同意|否决)$/.test(s)) return VOTES.DISAGREE;
  return null;
}

/**
 * Count the votes. **Counting only, no conclusion** —— the conclusion is in isConsensus; keeping
 * the two apart makes them easy to test.
 *
 * @param {Array<{vote?:unknown, status?:string}>} utterances everyone's output this round (including the failed ones)
 * @returns {{seats:number, agree:number, disagree:number, abstain:number, invalid:number}}
 *   seats is how many were actually asked this round (= attendance); invalid is how many gave no
 *   valid position.
 */
function tally(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  let agree = 0;
  let disagree = 0;
  let abstain = 0;
  for (const u of list) {
    // The process did not complete (timeout / crash / unparseable) → no position expressed,
    // whatever vote field it carries is ignored
    const status = (u && u.status) || 'ok';
    const vote = status === 'ok' ? normalizeVote(u && u.vote) : null;
    if (vote === VOTES.AGREE) agree += 1;
    else if (vote === VOTES.DISAGREE) disagree += 1;
    else if (vote === VOTES.ABSTAIN) abstain += 1;
  }
  const seats = list.length;
  return { seats, agree, disagree, abstain, invalid: seats - agree - disagree - abstain };
}

/**
 * Decide whether this round reached consensus.
 *
 * **Both criteria require "nobody left without a position"**: a round where someone did not answer
 * cannot be called a deal —— that is not harshness, it follows directly from "do not fabricate":
 * we **do not know** the absentee's position, and treating the unknown as acquiescence invents a
 * position for it. One participant crashing and voiding the round is far more honest than passing
 * 3 votes off as a 4-vote consensus; the next round will ask again.
 *
 * @param {{seats:number,agree:number,disagree:number,abstain:number,invalid:number}} t
 * @param {string} [threshold] see THRESHOLDS; unrecognized values fall back to UNANIMOUS
 * @returns {boolean}
 */
function isConsensus(t, threshold) {
  if (!t || t.seats <= 0) return false;
  if (t.invalid > 0) return false; // somebody expressed no position → the round does not stand (same for both criteria)
  // Under the majority criterion **objections are normal** —— do not hoist the disagree check above
  // this line, that would kill "3 agree, 1 disagree" too and make majority rule pointless.
  if (threshold === THRESHOLDS.MAJORITY) return t.agree > t.disagree;
  if (t.disagree > 0) return false; // unanimous: any objection voids it
  // Default unanimous: agreement must **reach half** (abstention is not agreement, but it does not
  // hold anyone back either).
  // Boundary: "exactly half counts" —— 2 participants, 1 agrees and the other explicitly abstains
  // (no objection) → stands.
  // All abstain → agree=0 → does not stand: something nobody endorsed is not consensus.
  return t.agree * 2 >= t.seats;
}

/**
 * Whose revision goes on the table next round.
 *
 * Rules (mechanical, deterministic, and the UI must state them honestly):
 *   1. Candidates = revisions submitted by those who voted disagree (objectors who submitted none
 *      produce no candidate);
 *   2. Take the one **seconded by the most** —— a second means someone named `second: <floor>` in
 *      their structured block this round;
 *   3. Tie / nobody seconded → take the first by **ascending floor id** (deterministic; do not pick
 *      the one that "looks better").
 *
 * Why the server does not "pick the best one": that would mean the server stepping in to write the
 * proposal for the participants, crossing "do not fabricate". Every step here uses only fields the
 * participants gave themselves.
 *
 * @param {Array<{floorId:string, status?:string, proposal?:string, second?:string}>} utterances
 * @returns {{floorId:string, text:string, seconds:number}|null} null when there is no usable candidate
 */
function pickProposal(utterances) {
  const list = Array.isArray(utterances) ? utterances : [];
  const byFloor = new Map();
  for (const u of list) {
    if (u && u.floorId) byFloor.set(String(u.floorId), u);
  }
  // Seconding tally: only entries naming a candidate floor count; seconding yourself does not
  const seconds = new Map();
  for (const u of list) {
    const target = u && u.second != null ? String(u.second) : '';
    if (!target) continue;
    if (u.floorId && String(u.floorId) === target) continue;
    seconds.set(target, (seconds.get(target) || 0) + 1);
  }

  let best = null;
  for (const [floorId, u] of byFloor) {
    if ((u.status || 'ok') !== 'ok') continue;
    const text = typeof u.proposal === 'string' ? u.proposal.trim() : '';
    if (!text) continue;
    const candidate = { floorId, text, seconds: seconds.get(floorId) || 0 };
    if (best == null) {
      best = candidate;
      continue;
    }
    if (candidate.seconds > best.seconds) best = candidate;
    // Tie (including nobody seconded either) → the smaller floor id wins, so the same inputs always
    // produce the same result
    else if (candidate.seconds === best.seconds && compareFloor(candidate.floorId, best.floorId) < 0) {
      best = candidate;
    }
  }
  return best;
}

/** Floor id ordering: '1F' < '4F' < '7F' < '8F'; unrecognized ids sort last and fall back to string comparison */
function compareFloor(a, b) {
  const na = parseInt(String(a), 10);
  const nb = parseInt(String(b), 10);
  const okA = Number.isFinite(na);
  const okB = Number.isFinite(nb);
  if (okA && okB && na !== nb) return na - nb;
  if (okA !== okB) return okA ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Full decision for one round: count votes + settle consensus + pick next round's proposal.
 * The orchestrator uses this directly.
 *
 * @param {{utterances:Array, threshold?:string, maxRounds:number, roundNo:number}} args
 *   roundNo is **this round's** ordinal (starting at 1); maxRounds is the discussion round cap.
 * @returns {{tally:object, consensus:boolean, nextProposal:object|null, done:boolean, outcome:string|null}}
 *   done=true means the meeting ends here; outcome is 'consensus' / 'no_consensus'; null while not finished.
 */
function decideRound({ utterances, threshold, maxRounds, roundNo }) {
  const t = tally(utterances);
  const consensus = isConsensus(t, threshold);
  if (consensus) {
    return { tally: t, consensus: true, nextProposal: null, done: true, outcome: 'consensus' };
  }
  const exhausted = !Number.isFinite(maxRounds) || roundNo >= maxRounds;
  if (exhausted) {
    return { tally: t, consensus: false, nextProposal: null, done: true, outcome: 'no_consensus' };
  }
  return {
    tally: t,
    consensus: false,
    nextProposal: pickProposal(utterances),
    done: false,
    outcome: null,
  };
}

module.exports = { VOTES, THRESHOLDS, normalizeVote, tally, isConsensus, pickProposal, decideRound, compareFloor };
