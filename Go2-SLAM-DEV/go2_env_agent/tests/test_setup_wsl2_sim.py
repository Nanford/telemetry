from pathlib import Path


def test_setup_script_uses_existing_cyclonedds_ref():
    script = Path(__file__).resolve().parents[1] / "debug" / "setup_wsl2_sim.sh"
    content = script.read_text(encoding="utf-8")

    assert '--branch "${CYCLONE_VER}" --depth 1' in content
    assert '--branch "releases/${CYCLONE_VER}"' not in content


def test_setup_script_uses_metadata_for_cyclonedds_version_check():
    script = Path(__file__).resolve().parents[1] / "debug" / "setup_wsl2_sim.sh"
    content = script.read_text(encoding="utf-8")

    assert "importlib.metadata" in content
    assert "metadata.version('cyclonedds')" in content
    assert "cyclonedds.__version__" not in content
