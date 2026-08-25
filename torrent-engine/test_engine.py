from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("engine.py")
SPEC = importlib.util.spec_from_file_location("netwatch_torrent_engine", MODULE_PATH)
assert SPEC and SPEC.loader
engine = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = engine
SPEC.loader.exec_module(engine)


class FakeStorage:
    def __init__(self):
        self._files = [
            ("show/sample.mkv", 4 * 1024 * 1024, 0),
            ("show/episode.mkv", 700 * 1024 * 1024, 4 * 1024 * 1024),
            ("show/readme.txt", 512, 704 * 1024 * 1024),
        ]

    def num_files(self):
        return len(self._files)

    def file_path(self, index, save_path=None):
        path = self._files[index][0]
        return str(Path(save_path) / path) if save_path else path

    def file_size(self, index):
        return self._files[index][1]

    def file_offset(self, index):
        return self._files[index][2]


class FakeInfo:
    def __init__(self, piece_size=1024 * 1024, pieces=800):
        self.storage = FakeStorage()
        self._piece_size = piece_size
        self._pieces = pieces

    def files(self):
        return self.storage

    def piece_length(self):
        return self._piece_size

    def num_pieces(self):
        return self._pieces


class FakeHandle:
    def __init__(self, info):
        self.info = info
        self.have = set()
        self.deadlines = []
        self.priorities = []
        self.clear_count = 0

    def is_valid(self):
        return True

    def torrent_file(self):
        return self.info

    def have_piece(self, piece):
        return piece in self.have

    def set_piece_deadline(self, piece, deadline):
        self.deadlines.append((piece, deadline))

    def piece_priority(self, piece, priority):
        self.priorities.append((piece, priority))

    def clear_piece_deadlines(self):
        self.clear_count += 1


class Status:
    def __init__(self, state, rate=1):
        self.state = state
        self.download_payload_rate = rate


class TorrentEngineUnitTests(unittest.TestCase):
    def make_engine(self):
        service = engine.TorrentEngine.__new__(engine.TorrentEngine)
        service._lock = __import__("threading").RLock()
        info = FakeInfo()
        handle = FakeHandle(info)
        record = engine.TorrentRecord(
            info_hash="a" * 40,
            handle=handle,
            save_path="/tmp/netwatch/" + "a" * 40,
            media_name="episode",
            selected_file_index=1,
            selected_path="/tmp/episode.mkv",
            selected_size=700 * 1024 * 1024,
            prepared=True,
        )
        service._records = {record.info_hash: record}
        return service, record, handle


    def test_save_path_is_engine_generated_not_hash_derived(self):
        with tempfile.TemporaryDirectory() as root:
            old_root = engine.DOWNLOAD_ROOT
            engine.DOWNLOAD_ROOT = root
            try:
                with patch.object(engine.secrets, "token_hex", return_value="b" * 32):
                    path = engine.TorrentEngine._create_save_path()
                self.assertEqual(Path(path).name, "torrent-" + "b" * 32)
                self.assertEqual(Path(path).parent, Path(root).resolve())
                self.assertTrue(Path(path).is_dir())
            finally:
                engine.DOWNLOAD_ROOT = old_root

    def test_video_selection_prefers_largest_non_sample(self):
        files = [
            {"index": 0, "name": "sample.mkv", "size": 50_000_000},
            {"index": 1, "name": "episode.mkv", "size": 700_000_000},
            {"index": 2, "name": "notes.txt", "size": 1_000},
        ]
        selected = engine.TorrentEngine.select_video_file(files)
        self.assertIsNotNone(selected)
        self.assertEqual(selected["index"], 1)
        self.assertFalse(selected["is_sample"])


    def test_hash_candidates_support_v1_and_v2(self):
        class Hashes:
            v1 = "1" * 40
            v2 = "2" * 64

        self.assertEqual(
            engine.TorrentEngine._hash_candidates(Hashes()),
            ["1" * 40, "2" * 64],
        )

    def test_state_mapping_matches_libtorrent_2(self):
        self.assertEqual(engine.TorrentEngine._state_name(Status(2)), "metaDL")
        self.assertEqual(engine.TorrentEngine._state_name(Status(3, rate=100)), "downloading")
        self.assertEqual(engine.TorrentEngine._state_name(Status(3, rate=0)), "stalledDL")
        self.assertEqual(engine.TorrentEngine._state_name(Status(4)), "finished")
        self.assertEqual(engine.TorrentEngine._state_name(Status(5)), "seeding")

    def test_time_critical_window_prioritizes_requested_pieces(self):
        service, record, handle = self.make_engine()
        first, last, _superseded, _cancelled = service._schedule_deadlines(
            record,
            file_index=1,
            start=0,
            end=4 * 1024 * 1024 - 1,
            lookahead_bytes=8 * 1024 * 1024,
        )
        self.assertLessEqual(first, last)
        requested = [deadline for piece, deadline in handle.deadlines if piece <= last]
        self.assertTrue(requested)
        self.assertTrue(all(deadline == 0 for deadline in requested))
        self.assertTrue(all(priority == 7 for _, priority in handle.priorities))

    def test_one_off_far_probe_does_not_clear_current_deadlines(self):
        service, record, handle = self.make_engine()
        service._schedule_deadlines(record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024)
        clear_before = handle.clear_count
        tail = record.selected_size - 2 * 1024 * 1024
        service._schedule_deadlines(
            record,
            1,
            tail,
            tail + 1024 * 1024 - 1,
            4 * 1024 * 1024,
        )
        self.assertEqual(handle.clear_count, clear_before)
        self.assertIsNotNone(record.pending_far_window)

    def test_repeated_far_request_confirms_seek_and_clears_stale_deadlines(self):
        service, record, handle = self.make_engine()
        service._schedule_deadlines(record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024)
        tail = record.selected_size - 2 * 1024 * 1024
        service._schedule_deadlines(record, 1, tail, tail + 1024 * 1024 - 1, 4 * 1024 * 1024)
        clear_before = handle.clear_count
        service._schedule_deadlines(record, 1, tail, tail + 1024 * 1024 - 1, 4 * 1024 * 1024)
        self.assertEqual(handle.clear_count, clear_before + 1)
        self.assertIsNone(record.pending_far_window)

    def test_old_request_cannot_erase_newer_pending_seek(self):
        service, record, handle = self.make_engine()
        old_generation = 100
        seek_generation = 200

        service._schedule_deadlines(
            record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024, old_generation
        )
        tail = record.selected_size - 20 * 1024 * 1024
        service._schedule_deadlines(
            record,
            1,
            tail,
            tail + 1024 * 1024 - 1,
            4 * 1024 * 1024,
            seek_generation,
        )
        pending = record.pending_far_window
        self.assertIsNotNone(pending)
        self.assertEqual(pending[3], seek_generation)

        # The still-running old HTTP stream polls again before the seek's second
        # scheduler pass. It must not erase the newer pending seek.
        service._schedule_deadlines(
            record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024, old_generation
        )
        self.assertIsNotNone(record.pending_far_window)
        self.assertEqual(record.pending_far_window[3], seek_generation)

        clear_before = handle.clear_count
        service._schedule_deadlines(
            record,
            1,
            tail,
            tail + 1024 * 1024 - 1,
            4 * 1024 * 1024,
            seek_generation,
        )
        self.assertEqual(handle.clear_count, clear_before + 1)
        self.assertEqual(record.active_request_generation, seek_generation)

    def test_superseded_old_request_cannot_steal_seek_window_back(self):
        service, record, handle = self.make_engine()
        old_generation = 100
        seek_generation = 200

        service._schedule_deadlines(
            record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024, old_generation
        )
        tail = record.selected_size - 20 * 1024 * 1024
        service._schedule_deadlines(
            record,
            1,
            tail,
            tail + 1024 * 1024 - 1,
            4 * 1024 * 1024,
            seek_generation,
        )
        service._schedule_deadlines(
            record,
            1,
            tail,
            tail + 1024 * 1024 - 1,
            4 * 1024 * 1024,
            seek_generation,
        )
        seek_window = record.deadline_window
        clear_before = handle.clear_count
        deadlines_before = len(handle.deadlines)

        status = service.range_status(
            record.info_hash,
            1,
            0,
            1024 * 1024 - 1,
            schedule=True,
            lookahead_bytes=4 * 1024 * 1024,
            request_generation=old_generation,
        )

        self.assertTrue(status["superseded"])
        self.assertFalse(status["ready"])
        self.assertEqual(handle.clear_count, clear_before)
        self.assertEqual(len(handle.deadlines), deadlines_before)
        self.assertEqual(record.deadline_window, seek_window)
        self.assertEqual(record.active_request_generation, seek_generation)

    def test_cancelling_probe_does_not_cancel_older_active_stream(self):
        service, record, handle = self.make_engine()
        active_generation = 100
        probe_generation = 200
        service._schedule_deadlines(
            record, 1, 0, 1024 * 1024 - 1, 4 * 1024 * 1024, active_generation
        )
        service.cancel_range_request(record.info_hash, probe_generation)

        status = service.range_status(
            record.info_hash,
            1,
            0,
            1024 * 1024 - 1,
            request_generation=active_generation,
        )
        self.assertFalse(status["cancelled"])
        self.assertFalse(status["superseded"])

        probe_status = service.range_status(
            record.info_hash,
            1,
            record.selected_size - 2 * 1024 * 1024,
            record.selected_size - 1024 * 1024 - 1,
            request_generation=probe_generation,
        )
        self.assertTrue(probe_status["cancelled"])



if __name__ == "__main__":
    unittest.main()
