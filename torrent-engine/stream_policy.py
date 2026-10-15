"""Bounded read-ahead from observed HTTP demand, not torrent download speed."""

from dataclasses import dataclass


MIB = 1024 * 1024


@dataclass
class DemandRate:
    rate: float = MIB
    sampled: bool = False
    cursor: int = 0
    at: float | None = None

    def reset(self):
        self.rate, self.sampled, self.cursor, self.at = MIB, False, 0, None

    def observe(self, cursor: int, now: float):
        if self.at is None or cursor < self.cursor or now - self.at > 15:
            self.cursor, self.at = cursor, now
            return
        elapsed = now - self.at
        # Accumulate rapid cache-fill reads into a sample; repeated piece waits
        # are not consumption. A seek resets the estimator at its new position.
        if cursor <= self.cursor or elapsed < 1:
            return
        observed = max(128 * 1024, min(32 * MIB, (cursor - self.cursor) / elapsed))
        self.rate = observed if not self.sampled else .75 * self.rate + .25 * observed
        self.sampled = True
        self.cursor, self.at = cursor, now

    def lookahead(self, limit: int, piece_size: int) -> int:
        target = self.rate * 12 if self.sampled else 8 * MIB
        return min(max(0, limit), int(max(4 * MIB, 2 * piece_size, target)))

    def deadline_ms(self, bytes_ahead: int) -> int:
        return min(30_000, max(50, int(1000 * bytes_ahead / self.rate)))
