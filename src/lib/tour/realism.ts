/**
 * Booker's-eye checks Qloo's data can't make by itself (it has no venue capacities and no band
 * line-ups). Name-based and stated as such on screen, so they flag, never hide.
 */

/** Well-known supergroups: bands of established names that draw like headliners, not openers. */
const SUPERGROUPS = ["the highwomen", "boygenius", "better oblivion community center", "monsters of folk", "traveling wilburys", "the traveling wilburys"];
export const isKnownSupergroup = (name: string) => SUPERGROUPS.includes(name.trim().toLowerCase().replace(/\s*\(sample\)$/, ""));

/** Room names that usually mean a theatre-size hall rather than a 100–500 club. */
const LARGE_ROOM = /\b(theat(?:re|er)|music hall|music cent(?:er|re)|ballroom|palace|pavilion|auditorium|opera house|amphitheat(?:er|re)|arena)\b/i;
export const soundsLarge = (roomName: string) => LARGE_ROOM.test(roomName);

/** A small-room tour: an emerging act, or a capacity target that tops out at 500. */
export const smallRoomTour = (capacity: [number, number] | undefined, emerging: boolean) => emerging || (capacity !== undefined && capacity[1] <= 500);
