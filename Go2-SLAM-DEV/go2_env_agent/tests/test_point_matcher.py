import os
import tempfile
import pytest
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models import Pose
from app.matcher.point_matcher import PointMatcher

YAML_CONTENT = """
area_id: test_area
points:
  - id: P1
    name: Point 1
    x: 0.0
    y: 0.0
    radius: 1.0
  - id: P2
    name: Point 2
    x: 5.0
    y: 0.0
    radius: 1.0
  - id: P3
    name: Point 3
    x: 0.5
    y: 0.0
    radius: 0.8
"""


@pytest.fixture
def matcher():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False, encoding="utf-8") as f:
        f.write(YAML_CONTENT)
        f.flush()
        m = PointMatcher(f.name, dwell_count=3)
    yield m
    os.unlink(f.name)


def _pose(x, y, fix=True):
    return Pose(source="test", frame="test", fix=fix, x=x, y=y, z=0.0, yaw=0.0)


class TestExactMatch:
    def test_hit_p1(self, matcher):
        result = matcher.match(_pose(0.0, 0.0))
        assert result.matched
        assert result.point_id == "P1"

    def test_hit_p2(self, matcher):
        result = matcher.match(_pose(5.0, 0.0))
        assert result.matched
        assert result.point_id == "P2"

    def test_within_radius(self, matcher):
        result = matcher.match(_pose(0.5, 0.5))
        assert result.matched
        assert result.point_id in ("P1", "P3")

    def test_outside_all_radii(self, matcher):
        result = matcher.match(_pose(100.0, 100.0))
        assert not result.matched
        assert result.point_id is None
        assert result.area_id == "test_area"


class TestOverlap:
    def test_nearest_wins(self, matcher):
        # (0.3, 0.0) is within both P1 (dist=0.3) and P3 (dist=0.2)
        result = matcher.match(_pose(0.3, 0.0))
        assert result.matched
        assert result.point_id == "P3"


class TestNoFix:
    def test_no_fix_returns_unmatched(self, matcher):
        result = matcher.match(_pose(0.0, 0.0, fix=False))
        assert not result.matched
        assert result.point_id is None

    def test_none_coords(self, matcher):
        pose = Pose(source="test", frame="test", fix=True, x=None, y=None, z=None, yaw=None)
        result = matcher.match(pose)
        assert not result.matched


class TestDwellFiltering:
    def test_dwell_count_transitions(self, matcher):
        # First 2 hits: timed
        for _ in range(2):
            result = matcher.match(_pose(0.0, 0.0))
            assert result.matched
            assert result.sample_type == "timed"

        # 3rd hit: point_valid
        result = matcher.match(_pose(0.0, 0.0))
        assert result.sample_type == "point_valid"

        # Stays point_valid
        result = matcher.match(_pose(0.0, 0.0))
        assert result.sample_type == "point_valid"

    def test_switching_point_resets_dwell(self, matcher):
        # Hit P1 twice
        matcher.match(_pose(0.0, 0.0))
        matcher.match(_pose(0.0, 0.0))

        # Switch to P2 — resets dwell counter
        result = matcher.match(_pose(5.0, 0.0))
        assert result.point_id == "P2"
        assert result.sample_type == "timed"

    def test_no_fix_resets_dwell(self, matcher):
        matcher.match(_pose(0.0, 0.0))
        matcher.match(_pose(0.0, 0.0))

        # Lose fix
        matcher.match(_pose(0.0, 0.0, fix=False))

        # Regain fix — dwell counter reset
        result = matcher.match(_pose(0.0, 0.0))
        assert result.sample_type == "timed"

    def test_outside_radius_resets_dwell(self, matcher):
        matcher.match(_pose(0.0, 0.0))
        matcher.match(_pose(0.0, 0.0))

        # Move outside all points
        matcher.match(_pose(100.0, 100.0))

        # Come back — dwell counter reset
        result = matcher.match(_pose(0.0, 0.0))
        assert result.sample_type == "timed"


class TestEdgeCases:
    def test_exact_radius_boundary(self, matcher):
        # P2 at (5.0, 0.0) radius=1.0, test at exactly (4.0, 0.0)
        result = matcher.match(_pose(4.0, 0.0))
        assert result.matched
        assert result.point_id == "P2"

    def test_just_outside_radius(self, matcher):
        # P2 at (5.0, 0.0) radius=1.0, just outside at (3.999, 0.0)
        result = matcher.match(_pose(3.999, 0.0))
        assert not result.matched
