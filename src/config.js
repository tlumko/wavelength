export const GAME = {
  zones: [
    { points: 4, halfWidth: 4 },
    { points: 3, halfWidth: 10 },
    { points: 2, halfWidth: 18 },
  ],
  writingSeconds: 360,
  revealSeconds: 60,
  maxClueLength: 80,
  maxNameLength: 20,
  minPlayers: 2,
  maxPlayers: 12,
  targetMin: 5,
  targetMax: 175,
  // Reveal reaction emojis by points scored; unknown point values fall back to 0.
  reactions: {
    4: ['🤯', '🔥', '🎯', '🎉', '👏'],
    3: ['🔥', '😎', '👏', '🙌', '👍'],
    2: ['❤️‍🩹', '🙂', '👌', '🤏', '😅'],
    0: ['😭', '💩', '💀', '🙈', '🫠'],
  },
  votingReactions: ['👍', '🤔', '👀', '🤡', '💩'],
  summaryReactions: ['😂', '🔥', '👏', '🎉', '😬', '💩'],
  reactionGapMs: 150,
};

export const cluesPerPlayer = (n) => (n <= 3 ? 3 : n <= 5 ? 2 : 1);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const LIMITS = {
  maxRooms: num(process.env.MAX_ROOMS, 20),
  idleTtlMs: num(process.env.IDLE_TTL_MIN, 30) * 60_000,
  maxAgeMs: num(process.env.MAX_AGE_MIN, 240) * 60_000,
};
