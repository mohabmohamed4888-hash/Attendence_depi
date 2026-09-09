/* =======================
   GROUP TRACKS (Technical / Non-Technical)
   Single source of truth shared by the Electron main process
   and the attendance sync script.
======================= */

const { GROUP_BATCH_TRACKS } = require('./group_batches');

const ROUND_5_TECHNICAL_GROUP_IDS = require('./lms-bot/round5_groups.json');
const ROUND_5_NON_TECHNICAL_GROUP_IDS = require('./lms-bot/round5_nontechnical_groups.json');

const TECHNICAL_CATEGORY = 'Technical groups';
const NON_TECHNICAL_CATEGORY = 'Non Technical groups';
const OTHERS_CATEGORY = 'Others';

const TRACK_ALL = 'all';
const TRACK_TECHNICAL = 'technical';
const TRACK_NON_TECHNICAL = 'nontechnical';

const ROUND_4_TECHNICAL_GROUPS = [
  'CAI4_SWD1_S2',
  'GHR4_SWD1_S1',
  'GIZ4_SWD1_S1',
  'MNF4_SWD1_S1',
  'CAI4_SWD2_S1',
  'CAI4_SWD2_S2',
  'GIZ4_SWD2_S5',
  'MNF4_SWD2_S1',
  'MNF4_SWD2_S2',
  'GHR4_SWD4_S1',
  'ONL4_DRT6_S1',
  'GIZ4_DRT5_S1',
  'AST4_AIS4_S1',
  'GHR4_AIS4_S1',
  'GIZ4_AIS4_S3',
  'GIZ4_AIS4_S4',
  'MNF4_AIS4_S1',
  'ONL4_AIS4_S1',
  'CAI4_AIS3_S3',
  'CAI4_AIS3_S2',
  'CAI4_AIS2_S11',
  'CAI4_AIS2_S12',
  'CAI4_AIS2_S13',
  'CAI4_AIS2_S2',
  'GHR4_AIS2_S1',
  'GIZ4_AIS2_S5',
  'MNF4_AIS2_S1',
  'ONL4_AIS2_S5',
  'ONL4_AIS2_S4',
  'GIZ4_DAT1_S4',
  'ONL4_AIS2_S11',
  'ONL4_AIS5_S10',
  'CAI4_AIS2_S3',
  'CAI4_SWD1_G1',
  'CAI4_SWD2_G1',
  'ONL4_SWD4_G1',
  'GIZ4_DRT5_G1',
  'ONL4_AIS4_G2',
  'ONL4_AIS3_G3',
  'CAI4_AIS5_G4',
  'GIZ4_DAT1_G4',
  'GIZ4_DAT1_G3',
];

const ROUND_4_NON_TECHNICAL_GROUPS = [
  'ALX4_ISS2_S1',
  'ALX4_ISS3_S1',
  'ALX4_ISS6_S1',
  'CAI4_AIS5_G2',
  'CAI4_AIS5_G3',
  'CAI4_AIS5_S2',
  'CAI4_AIS5_S4',
  'CAI4_ISS10_G1',
  'CAI4_ISS10_S1',
  'CAI4_ISS2_G1',
  'CAI4_ISS2_S1',
  'CAI4_ISS2_S2',
  'CAI4_ISS3_G1',
  'CAI4_ISS3_S1',
  'CAI4_ISS3_S2',
  'CAI4_ISS3_S3',
  'CAI4_ISS3_S4',
  'CAI4_ISS6_G1',
  'CAI4_ISS6_S1',
  'CAI4_ISS6_S2',
  'CAI4_ISS6_S3',
  'CAI4_ISS7_S1',
  'GHR4_ISS3_S1',
  'GIZ4_AIS5_G1',
  'GIZ4_AIS5_S3',
  'GIZ4_ISS2_S1',
  'GIZ4_ISS3_S1',
];

function ownerGroupsForTrack(track) {
  return Object.values(GROUP_BATCH_TRACKS[track] || {}).flat();
}

const TECHNICAL_GROUPS = new Set([
  ...ROUND_4_TECHNICAL_GROUPS,
  ...Object.keys(ROUND_5_TECHNICAL_GROUP_IDS),
  ...ownerGroupsForTrack(TRACK_TECHNICAL),
]);

const NON_TECHNICAL_GROUPS = new Set([
  ...ROUND_4_NON_TECHNICAL_GROUPS,
  ...Object.keys(ROUND_5_NON_TECHNICAL_GROUP_IDS),
  ...ownerGroupsForTrack(TRACK_NON_TECHNICAL),
]);

function normalizeTrack(rawTrack) {
  const track = String(rawTrack || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (track === 'technical' || track === 'tech') return TRACK_TECHNICAL;
  if (track === 'nontechnical' || track === 'nontech') return TRACK_NON_TECHNICAL;
  return TRACK_ALL;
}

function getGroupCategory(group) {
  const name = String(group || '').trim();
  if (TECHNICAL_GROUPS.has(name)) return TECHNICAL_CATEGORY;
  if (NON_TECHNICAL_GROUPS.has(name)) return NON_TECHNICAL_CATEGORY;
  return OTHERS_CATEGORY;
}

function getGroupTrack(group) {
  const category = getGroupCategory(group);
  if (category === TECHNICAL_CATEGORY) return TRACK_TECHNICAL;
  if (category === NON_TECHNICAL_CATEGORY) return TRACK_NON_TECHNICAL;
  return '';
}

function matchesTrack(group, rawTrack) {
  const track = normalizeTrack(rawTrack);
  if (track === TRACK_ALL) return true;
  return getGroupTrack(group) === track;
}

function trackLabel(rawTrack) {
  const track = normalizeTrack(rawTrack);
  if (track === TRACK_TECHNICAL) return 'Technical';
  if (track === TRACK_NON_TECHNICAL) return 'Non-Technical';
  return 'All';
}

module.exports = {
  TRACK_ALL,
  TRACK_TECHNICAL,
  TRACK_NON_TECHNICAL,
  TECHNICAL_CATEGORY,
  NON_TECHNICAL_CATEGORY,
  OTHERS_CATEGORY,
  TECHNICAL_GROUPS,
  NON_TECHNICAL_GROUPS,
  ROUND_5_TECHNICAL_GROUP_IDS,
  ROUND_5_NON_TECHNICAL_GROUP_IDS,
  normalizeTrack,
  getGroupCategory,
  getGroupTrack,
  matchesTrack,
  trackLabel,
};
