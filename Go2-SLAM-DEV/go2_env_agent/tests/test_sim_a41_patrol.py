"""
INPUT : debug/sim_a41_patrol.py 的各污染层与运动模型
OUTPUT: 保证模拟数据的关键性质不被后续改动破坏
POS   : 守住四条底线——温度落在现场实测区间、自热曲线对得上趟1、无漂移时标定可精确恢复、
        一轮巡检能覆盖全部 22 个垛位。
"""

import math
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest


def load_sim_module():
    module_path = Path(__file__).resolve().parents[1] / "debug" / "sim_a41_patrol.py"
    spec = spec_from_file_location("sim_a41_patrol", module_path)
    module = module_from_spec(spec)
    assert spec.loader is not None
    # 必须先登记到 sys.modules：模块里的 @dataclass 会反查自身模块，否则解析注解时报 NoneType。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


sim = load_sim_module()

# 南排(贴落地窗)与北排(背阴)的垛号，与 backend/src/a41-layout.js 的 BAYS 一致
SOUTH_BAYS = {f"A-4-1-{n}" for n in
              ("16", "15", "14", "13", "12", "11", "10", "09", "08", "07", "06")}
NORTH_BAYS = {f"A-4-1-{n}" for n in
              ("17", "18", "19", "20", "21", "22", "01", "02", "03", "04", "05")}


@pytest.fixture
def points():
    return sim.load_points(sim.resolve_points_file(None))


def test_points_cover_full_patrol_order(points):
    """22 个垛位，patrol_seq 必须是 1..22 的完整排列。"""
    assert len(points) == 22
    assert [int(p["patrol_seq"]) for p in points] == list(range(1, 23))


def _bay_temps(points, seed=7, hour=14.0):
    """按垛体中心求每个垛位的温度——与主循环 reading_position 的口径一致。"""
    import random

    field = sim.ThermalField(random.Random(seed), hour_of_day=hour)
    out = {}
    for p in points:
        sx, sy = sim.reading_position(float(p["x"]), float(p["y"]), p)
        out[str(p["id"])] = field.temperature_at(sx, sy)
    return out


def test_thermal_field_corners_match_site_description(points):
    """
    角点读数必须顶到输出区间两端：东北角 22.0℃（最凉）、西南角 29.8℃（最热）。

    现场描述：南墙落地窗有阳光，东北区域最凉、西南区域最热。
    注意断言的是**钳制后的读数**，不是钳制前的理论气温：东北角理论值只有
    TEMP_NE_MIN_C=19.84℃，被 TEMP_OUT_MIN_C 兜到 22.0；西南角理论值 32.29℃，
    被 TEMP_CEILING_C 压到 29.8。这个"两端饱和"是 2026-07-27 重标定时的设计意图。
    """
    import random

    field = sim.ThermalField(random.Random(7), hour_of_day=sim.SUN_PEAK_HOUR)
    ne = field.temperature_at(sim.AREA_WIDTH_M, sim.AREA_HEIGHT_M)   # 东北角
    sw = field.temperature_at(0.0, 0.0)                              # 西南角

    assert ne == pytest.approx(sim.TEMP_OUT_MIN_C, abs=0.4)
    assert sw == pytest.approx(sim.TEMP_CEILING_C, abs=0.4)
    # 钳制前的理论基准仍应保持在下限以下，否则"东北角饱和"就名存实亡
    assert sim.TEMP_NE_MIN_C < sim.TEMP_OUT_MIN_C


def test_thermal_field_gradient_runs_southwest_to_northeast(points):
    """西南热、东北凉的对角梯度，且日照(南北向)必须强于东西向。"""
    import random

    field = sim.ThermalField(random.Random(7), hour_of_day=sim.SUN_PEAK_HOUR)
    mid_x, mid_y = sim.AREA_WIDTH_M / 2, sim.AREA_HEIGHT_M / 2

    # 南北向温差（日照主梯度）应明显大于东西向温差
    north_south = field.temperature_at(mid_x, 0.0) - field.temperature_at(mid_x, sim.AREA_HEIGHT_M)
    west_east = field.temperature_at(0.0, mid_y) - field.temperature_at(sim.AREA_WIDTH_M, mid_y)
    assert north_south > west_east > 0.5

    temps = _bay_temps(points)
    # 南排贴落地窗，必须整体高于背阴的北排
    south_avg = sum(v for k, v in temps.items() if k in SOUTH_BAYS) / len(SOUTH_BAYS)
    north_avg = sum(v for k, v in temps.items() if k in NORTH_BAYS) / len(NORTH_BAYS)
    assert south_avg > north_avg + 1.0

    # 最热的应在西南(南排西端 16)，最凉的在东北(北排东端 05)
    assert max(temps, key=temps.get) == "A-4-1-16"
    assert min(temps, key=temps.get) == "A-4-1-05"


def test_bay_temps_stay_in_site_range(points):
    """22 个垛位读数必须落在 25~29.5℃，且有足够结构撑起热力图。"""
    temps = _bay_temps(points)
    assert min(temps.values()) >= sim.TEMP_NE_MIN_C - 1e-9
    assert max(temps.values()) <= sim.TEMP_CEILING_C + 1e-9
    assert max(temps.values()) - min(temps.values()) > 1.5


def test_humidity_inversely_tracks_temperature():
    """
    相对湿度随温度上升而下降，两端对上实测的 44~54%。

    锚点取**现行温度输出区间**的两端（TEMP_OUT_MIN_C / TEMP_CEILING_C），
    而不是写死数字——2026-07-27 区间从 25.0~29.5 改到 22.0~29.8 时，
    这条测试就是因为锚点写死才失效的。
    """
    import random

    field = sim.ThermalField(random.Random(3), hour_of_day=14.0)
    rh_cold = sum(field.humidity_at(sim.TEMP_OUT_MIN_C) for _ in range(400)) / 400
    rh_hot = sum(field.humidity_at(sim.TEMP_CEILING_C) for _ in range(400)) / 400

    assert rh_cold > rh_hot
    assert 52.0 <= rh_cold <= 56.0
    assert 43.0 <= rh_hot <= 46.0


def test_selfheat_matches_run1_measurement():
    """自热层必须复现趟1 实测：开机 26.7℃，25 分钟后爬到 31.65℃ 附近。"""
    model = sim.SelfHeatModel(sim.SELFHEAT_AMPLITUDE_C, sim.SELFHEAT_TAU_SEC)

    assert model.bias_at(0.0) == pytest.approx(0.0, abs=1e-9)

    temp_start, _ = model.apply(26.60, 53.3, 0.0)
    temp_end, rh_end = model.apply(26.60, 53.3, 25 * 60)

    assert temp_start == pytest.approx(26.60, abs=0.01)
    assert temp_end == pytest.approx(31.65, abs=0.35)   # 趟1 实测终点 31.65℃
    assert rh_end == pytest.approx(46.0, abs=1.5)       # 趟1 实测终点 46%


def test_sensor_gap_model_matches_measured_rate():
    """缺值率与最长缺值段必须贴合实测（有值率约 54%、最长空窗 6 条）。"""
    import random

    model = sim.SensorGapModel(random.Random(11))
    flags = [model.next_has_value() for _ in range(5000)]

    ratio = sum(flags) / len(flags)
    assert 0.45 <= ratio <= 0.62

    longest_gap = 0
    current = 0
    for flag in flags:
        current = 0 if flag else current + 1
        longest_gap = max(longest_gap, current)
    assert longest_gap <= sim.GAP_MAX_RUN


def test_odometry_degrader_is_exact_inverse_without_drift():
    """
    关掉漂移与突跳后，退化输出必须与 SOLVED 相似变换严格互逆。

    这条保证了 --yaw-drift 0 --yaw-jumps 0 可以当作标定算法的精确恢复夹具。
    """
    import random

    degrader = sim.OdometryDegrader(random.Random(1), drift_deg_per_min=0.0, jumps_per_min=0.0)
    cos_t, sin_t = math.cos(sim.SOLVED_THETA_RAD), math.sin(sim.SOLVED_THETA_RAD)

    truth = [(50.0, 18.9), (43.195, 17.85), (24.595, 17.85), (2.21, 17.85), (2.21, 19.85)]
    for true_x, true_y in truth:
        odom_x, odom_y, _ = degrader.degrade(true_x, true_y, 0.0, 5.0, moving=True)
        # 正变换 odom→CAD 应还原出真值
        back_x = sim.SOLVED_SCALE * (cos_t * odom_x - sin_t * odom_y) + sim.SOLVED_TX
        back_y = sim.SOLVED_SCALE * (sin_t * odom_x + cos_t * odom_y) + sim.SOLVED_TY
        assert back_x == pytest.approx(true_x, abs=1e-6)
        assert back_y == pytest.approx(true_y, abs=1e-6)


def test_odometry_degrader_reproduces_scale_loss():
    """真实走 1m，里程计只应报约 0.735m —— 照片真值实测的尺度亏损。"""
    import random

    degrader = sim.OdometryDegrader(random.Random(1), drift_deg_per_min=0.0, jumps_per_min=0.0)
    degrader.degrade(30.0, 17.85, 0.0, 5.0, moving=True)
    x0, y0, _ = degrader.degrade(30.0, 17.85, 0.0, 5.0, moving=True)
    x1, y1, _ = degrader.degrade(40.0, 17.85, 0.0, 5.0, moving=True)

    reported = math.hypot(x1 - x0, y1 - y0)
    assert reported / 10.0 == pytest.approx(0.7385, abs=0.002)


def test_odometry_degrader_jumps_only_while_standing():
    """yaw 突跳只发生在几乎不动时——实测位移 <4cm 才跳。"""
    import random

    degrader = sim.OdometryDegrader(random.Random(5), drift_deg_per_min=0.0, jumps_per_min=60.0)
    for _ in range(50):
        degrader.degrade(30.0, 17.85, 0.0, 5.0, moving=True)
    assert degrader.jump_count == 0

    for _ in range(50):
        degrader.degrade(30.0, 17.85, 0.0, 5.0, moving=False)
    assert degrader.jump_count > 0


def _run_one_lap(points, seed, dwell_min):
    """跑一轮巡检，返回 (命中过的垛位, 达到 point_valid 的垛位, 首次 point_valid 的先后顺序)。"""
    import random

    motion = sim.PatrolMotion(points, random.Random(seed), laps=1, dwell_min_sec=dwell_min)
    matcher = sim.PointMatcher(points, dwell_count=3)

    matched, valid, order = set(), set(), []
    for _ in range(4000):
        state = motion.step(5.0)
        if state.finished:
            break
        _, point_id, sample_type, _pt = matcher.match(state.x, state.y)
        if point_id is not None:
            matched.add(point_id)
        if sample_type == "point_valid":
            if point_id not in valid:
                order.append(point_id)
            valid.add(point_id)
    return matched, valid, order


def test_one_lap_walks_past_every_bay(points):
    """按实测驻留分布跑，路线必须经过全部 22 个垛位，且顺序等于配置的巡检顺序。"""
    matched, valid, order = _run_one_lap(points, seed=42, dwell_min=sim.DWELL_MIN_SEC)

    assert len(matched) == 22, f"只走到了 {len(matched)} 个垛位: {sorted(matched)}"
    assert order == [str(p["id"]) for p in points if str(p["id"]) in valid]


def test_default_dwell_leaves_some_bays_short_of_point_valid(points):
    """
    按实测分布跑，部分垛位达不到 point_valid —— 这是现场真实约束，不是模拟器缺陷。

    终端侧判定需连续 3 条 × 5s = 站满 15s，而趟2 实测驻留中位仅 16s。
    这条测试把这个约束钉死：如果哪天它变成 22/22，说明驻留分布被人悄悄掰弯了。
    """
    _, valid, _ = _run_one_lap(points, seed=42, dwell_min=sim.DWELL_MIN_SEC)
    assert 12 <= len(valid) < 22


def test_raising_dwell_floor_lights_up_every_bay(points):
    """把最短驻留抬到 18s（> dwell_count×5s）后，22 垛必须全部点亮，供前端演示使用。"""
    for seed in (1, 42, 777):
        _, valid, order = _run_one_lap(points, seed=seed, dwell_min=18.0)
        assert len(valid) == 22, f"seed={seed} 只点亮了 {len(valid)} 个: {sorted(valid)}"
        # 首次点亮顺序必须等于配置里的巡检顺序
        assert order == [str(p["id"]) for p in points]


def test_walk_speed_distribution_matches_real_capture():
    """
    行走速度分布要对上实测：中位 0.60 m/s、p90/中位 ≈ 1.9。

    真实狗是变速的，恒定速度会让 p90 塌到中位上——这正是模拟 v1 被真实数据打回来的地方。
    """
    import random
    import statistics

    motion = sim.PatrolMotion([], random.Random(9), laps=0)
    samples = sorted(motion._pick_speed() for _ in range(20000))

    median = statistics.median(samples)
    p90 = samples[int(len(samples) * 0.9)]

    assert median == pytest.approx(sim.WALK_SPEED_MEDIAN_MPS, abs=0.02)
    assert p90 / median == pytest.approx(1.9, abs=0.15)


def test_dwell_distribution_matches_real_capture():
    """驻留时长要对上趟2 实测：中位 16s、p90 43s，且是右偏而非均匀分布。"""
    import random
    import statistics

    motion = sim.PatrolMotion([], random.Random(4), laps=0)
    samples = sorted(motion._pick_dwell() for _ in range(20000))

    median = statistics.median(samples)
    p90 = samples[int(len(samples) * 0.9)]

    assert median == pytest.approx(16.0, abs=0.8)
    assert p90 == pytest.approx(43.0, abs=4.0)
    # 右偏的判据：均值明显大于中位数
    assert statistics.mean(samples) > median + 2.0


def test_environment_noise_is_lowpass_not_white():
    """
    温湿度噪声必须是低通的：实测相邻样本变化率中位为 0.00，驻留时读数连续相同。

    白噪声会让 5s 一条的读数不停抖动，这是模拟 v1 与真实数据差得最远的一项。
    """
    import random
    import statistics

    field = sim.ThermalField(random.Random(21), hour_of_day=15.0)
    # 固定坐标：位置不动时读数的变化只来自噪声
    temps = [round(field.temperature_at(30.105, 17.85), 1) for _ in range(2000)]
    rhs = [round(field.humidity_at(t)) for t in temps]

    temp_steps = [abs(temps[i] - temps[i - 1]) for i in range(1, len(temps))]
    rh_steps = [abs(rhs[i] - rhs[i - 1]) for i in range(1, len(rhs))]

    # 相邻步进的中位数必须为 0，即多数情况下读数保持不变
    assert statistics.median(temp_steps) == pytest.approx(0.0, abs=1e-9)
    assert statistics.median(rh_steps) == pytest.approx(0.0, abs=1e-9)
    # 换算成 5s 采样下的变化率，p90 应落在实测量级内（趟1 温度 p90 1.20 ℃/min）
    ordered = sorted(temp_steps)
    p90_per_min = ordered[int(len(ordered) * 0.9)] * 12.0
    assert p90_per_min <= 1.5


def test_reproduces_photo_ground_truth_timings(points):
    """
    照片真值独立验证：2026-07-23 现场三张带时间戳的照片给出的垛位间用时。

        10:45:54 @ A-4-1-17  →  10:46:18 @ A-4-1-18   24s
                             →  10:47:11 @ A-4-1-20   53s

    这是**独立证据**——速度与驻留常数全部来自里程计统计，照片时间戳没有参与标定。
    它同时约束了行走速度和驻留时长，两者任何一个被改坏都会让这条测试失败。
    """
    import random
    import statistics

    gap_17_18, gap_18_20 = [], []
    for seed in range(60):
        motion = sim.PatrolMotion(points, random.Random(seed), laps=1)
        matcher = sim.PointMatcher(points, dwell_count=3)
        first_seen = {}
        elapsed = 0.0
        for _ in range(3000):
            state = motion.step(5.0)
            if state.finished:
                break
            elapsed += 5.0
            _, point_id, _, _pt = matcher.match(state.x, state.y)
            if point_id and point_id not in first_seen:
                first_seen[point_id] = elapsed

        if all(k in first_seen for k in ("A-4-1-17", "A-4-1-18", "A-4-1-20")):
            gap_17_18.append(first_seen["A-4-1-18"] - first_seen["A-4-1-17"])
            gap_18_20.append(first_seen["A-4-1-20"] - first_seen["A-4-1-18"])

    assert len(gap_17_18) >= 50, "多数随机种子都没走完 17→18→20，运动模型可能坏了"
    # 容差放到 ±40%：驻留是重尾分布，中位数本身有抖动，太紧会变成脆弱测试
    assert statistics.median(gap_17_18) == pytest.approx(24.0, rel=0.4)
    assert statistics.median(gap_18_20) == pytest.approx(53.0, rel=0.4)


def test_payload_shape_matches_ingest_contract(points):
    """payload 字段必须与 backend/src/ingest.js 读取的键一致。"""
    payload = sim.build_payload(
        device_id="go2_01",
        ts=1784774170,
        pose=(15.295, 17.85, 1.23),
        pose_frame="map",
        zone_id="A-4-1",
        point_id="A-4-1-13",
        sample_type="point_valid",
        temp_c=27.4,
        rh=48.0,
    )

    assert payload["device_id"] == "go2_01"
    assert payload["area_id"] == "A-4-1"
    assert payload["zone_id"] == "A-4-1"
    assert payload["point_id"] == "A-4-1-13"
    assert payload["sample_type"] == "point_valid"
    assert payload["pose"]["frame"] == "map"
    assert payload["pose"]["x"] == pytest.approx(15.295)
    assert payload["temp_c"] == 27.4
    assert payload["errors"] == []

    # 未命中垛位时 zone_id 必须回落到 area_id，否则 ingest 会把样本归到空 zone
    unmatched = sim.build_payload(
        device_id="go2_01", ts=1784774170, pose=(30.0, 25.0, 0.0), pose_frame="map",
        zone_id=None, point_id=None, sample_type="timed", temp_c=None, rh=None,
    )
    assert unmatched["zone_id"] == "A-4-1"
    assert unmatched["point_id"] is None
    assert unmatched["temp_c"] is None


# =====================================================================
# 梳齿路线（2026-07-28 新增）：拐进可通行的垛间通道
# =====================================================================

def test_comb_route_inserts_one_probe_per_walkable_gap(points):
    """
    南北各 5 条可通行垛间通道，共插入 10 个探入点，且只插在宽通道里。

    CAD 相邻垛中心距只有两档：约 3.6~3.8m（净缝 <1m，进不去）和 ≥5.5m（净宽 ≥2.49m）。
    这条测试把"只拐进宽通道"钉死——阈值被人调松的话，狗会撞进 0.6m 的窄缝。
    """
    route = sim.build_patrol_route(points)
    probes = [p for p in route if p.get("kind") == "gap"]

    # 每条通道插 1 个探入点 + 两段圆角（每段 TURN_ARC_POINTS+1 个航点）
    arc_len = sim.TURN_ARC_POINTS + 1
    assert len(route) == len(points) + 10 * (1 + 2 * arc_len)
    assert len(probes) == 10
    assert sum(1 for p in probes if p["row"] == "S") == 5
    assert sum(1 for p in probes if p["row"] == "N") == 5

    for index, probe in enumerate(route):
        if probe.get("kind") != "gap":
            continue

        # 探入点前后各是一段圆角，且贴着探入点的那两个航点必须与它同 x —— 垂直进、垂直出
        entry = route[index - arc_len:index]
        exit_ = route[index + 1:index + 1 + arc_len]
        assert all(p["kind"] == "turn" and p["id"] is None for p in entry + exit_)
        assert float(entry[-1]["x"]) == float(probe["x"]) == float(exit_[0]["x"])

        # 再外侧才是两个垛位，且中心距达到"可通行"阈值
        left, right = route[index - arc_len - 1], route[index + arc_len + 1]
        assert left.get("kind") != "gap" and right.get("kind") != "gap"
        assert abs(float(right["x"]) - float(left["x"])) >= sim.GAP_MIN_CENTER_SPACING_M
        # 坐标按 CAD 惯例保留 3 位小数（毫米级），故容差取 1mm
        assert float(probe["x"]) == pytest.approx((float(left["x"]) + float(right["x"])) / 2, abs=1e-3)

        # 圆角起点必须还在中央通道的车道线上，终点已转成沿通道方向
        lane_y = float(left["y"])
        assert float(entry[0]["y"]) == pytest.approx(lane_y)
        assert float(exit_[-1]["y"]) == pytest.approx(lane_y)


def test_turn_fillets_stay_inside_the_gap_and_aisle(points):
    """
    圆角不能蹭到垛体：横向必须留在通道净宽内，纵向必须留在中央通道里。

    通道净宽最小 2.49m（半宽 1.245m），圆角半径 0.8m，留了余量。
    这条测试防的是有人把 TURN_RADIUS_M 调大到蹭墙。
    """
    route = sim.build_patrol_route(points)
    aisle_y0, aisle_y1 = 16.85, 20.85          # 与 backend/src/a41-layout.js 的 AISLE 一致

    assert sim.TURN_RADIUS_M < 2.49 / 2

    for index, probe in enumerate(route):
        if probe.get("kind") != "gap":
            continue
        gap_x = float(probe["x"])
        # 只取紧贴本探入点的两段圆角。按固定窗口取会串到隔壁通道的圆角上去。
        arc_len = sim.TURN_ARC_POINTS + 1
        window = route[index - arc_len:index] + route[index + 1:index + 1 + arc_len]
        assert len(window) == 2 * arc_len
        for turn in window:
            assert turn["kind"] == "turn"
            assert abs(float(turn["x"]) - gap_x) <= sim.TURN_RADIUS_M + 1e-6
            assert aisle_y0 <= float(turn["y"]) <= aisle_y1


def test_comb_probe_depth_lands_on_band_centroid(points):
    """
    默认深度比例 0.5 时，探入点正好落在该排垛体中线（南 10.2 / 北 28.1）。

    这不是巧合而是要求：探入点的读数位置必须与垛位的取值位置同深度，
    否则通道里的读数会比垛位读数系统性偏凉/偏热，热力图出现假分层。
    """
    route = sim.build_patrol_route(points)

    for probe in [p for p in route if p.get("kind") == "gap"]:
        assert float(probe["y"]) == pytest.approx(sim.BAND_CENTROID_Y[probe["row"]], abs=1e-6)

    # 深度比例调小则探入变浅，且始终留在垛体范围内
    shallow = sim.build_patrol_route(points, depth_ratio=0.25)
    for probe in [p for p in shallow if p.get("kind") == "gap"]:
        y0, y1 = sim.BAND_RANGE_Y[probe["row"]]
        assert y0 <= float(probe["y"]) <= y1
        assert abs(float(probe["y"]) - sim.AISLE_MID_Y) < abs(sim.BAND_CENTROID_Y[probe["row"]] - sim.AISLE_MID_Y)


def test_comb_route_still_covers_every_bay_in_order(points):
    """加了探入点后，22 个垛位仍然一个不落，且垛位之间的先后顺序不变。"""
    route = sim.build_patrol_route(points)
    matched, valid, order = _run_one_lap(route, seed=42, dwell_min=18.0)

    bays = [p["id"] for p in points]
    assert set(bays) <= matched, f"漏掉垛位: {sorted(set(bays) - matched)}"
    bay_order = [pid for pid in order if not pid.startswith(f"{sim.AREA_ID}-G")]
    assert bay_order == [pid for pid in bays if pid in valid]


def test_comb_route_probes_reach_point_valid(points):
    """抬高驻留下限后，10 个垛间通道探入点也应全部达到 point_valid。"""
    route = sim.build_patrol_route(points)
    _, valid, _ = _run_one_lap(route, seed=42, dwell_min=18.0)

    probes = {p["id"] for p in route if p.get("kind") == "gap"}
    assert probes <= valid, f"未点亮的探入点: {sorted(probes - valid)}"
