# Zone Id And Area Id Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pi agent publish `zone_id=A1..A5` while preserving `area_id=warehouse_1f`, and let the backend ingest and store both without breaking existing rule logic.

**Architecture:** Keep spatial matching on the Pi side, where SLAM coordinates are already interpreted. Treat `zone_id` as the backend's business primary key and store `area_id` as contextual metadata in both payloads and raw telemetry rows.

**Tech Stack:** Python 3.11, pytest, CommonJS Node.js, MySQL SQL migrations

---

### Task 1: Fix Pi Matcher Semantics

**Files:**
- Modify: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/app/models.py`
- Modify: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/app/matcher/point_matcher.py`
- Modify: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/app/config/points.yaml`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_point_matcher.py`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_payload.py`

- [ ] Write failing pytest coverage for point-level `zone_id` and payload serialization.
- [ ] Run the focused pytest commands and confirm the new assertions fail for the current code.
- [ ] Implement the minimal matcher and model changes so matched points expose `zone_id` while preserving `area_id`.
- [ ] Run the focused pytest commands again and confirm they pass.

### Task 2: Fix Pi Telemetry Payloads

**Files:**
- Modify: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/app/services/telemetry_service.py`
- Add: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_telemetry_service.py`

- [ ] Write a failing test showing `collect_once()` emits `zone_id` from the matched point and keeps `area_id` separate.
- [ ] Run the focused pytest command and confirm the assertion fails.
- [ ] Implement the payload correction in `telemetry_service.py`.
- [ ] Run the focused pytest command again and confirm it passes.

### Task 3: Add Backend Compatibility

**Files:**
- Modify: `D:/PersonalWork/codingProject/telemetry/backend/src/ingest.js`
- Modify: `D:/PersonalWork/codingProject/telemetry/backend/sql/schema.sql`
- Add: `D:/PersonalWork/codingProject/telemetry/backend/sql/add_area_id_column.sql`
- Add: `D:/PersonalWork/codingProject/telemetry/backend/scripts/test-normalize-telemetry.js`

- [ ] Write a failing Node.js validation script that asserts backend normalization keeps `area_id` and resolves `zone_id` from the payload correctly.
- [ ] Run the script and confirm it fails.
- [ ] Implement a small normalization helper in `ingest.js`, use it from the MQTT handler, and extend the insert columns to include `area_id`.
- [ ] Add the SQL migration and base schema column for `area_id`.
- [ ] Run the validation script again and confirm it passes.

### Task 4: Regression Verification

**Files:**
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_point_matcher.py`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_payload.py`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_telemetry_service.py`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_setup_wsl2_sim.py`
- Test: `C:/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent/tests/test_sim_go2_dog.py`
- Test: `D:/PersonalWork/codingProject/telemetry/backend/scripts/test-normalize-telemetry.js`

- [ ] Run the full Go2 agent pytest suite.
- [ ] Run the backend normalization validation script.
- [ ] Review the resulting payload semantics against the approved design: `zone_id=A1..A5`, `area_id=warehouse_1f`, `point_id=A1..A5`.
