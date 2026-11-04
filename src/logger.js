// In-memory ring buffer of events. Never pass clue text here, only lengths.
const MAX = 5000;
const buffer = [];

export function log(event, data = {}, room = null) {
  const entry = { ts: Date.now(), room, event, data };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  if (!process.env.LOG_SILENT) console.log(JSON.stringify(entry));
  return entry;
}

export function query({ room, limit = 200 } = {}) {
  const rows = room ? buffer.filter((e) => e.room === room) : buffer;
  return rows.slice(-Math.max(1, limit));
}
