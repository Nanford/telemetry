from dataclasses import dataclass
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def load_sim_module():
    module_path = Path(__file__).resolve().parents[1] / "debug" / "sim_go2_dog.py"
    spec = spec_from_file_location("sim_go2_dog", module_path)
    module = module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@dataclass
class FakeTimeSpec:
    sec: int
    nanosec: int


@dataclass
class FakeImuState:
    quaternion: list[float]
    gyroscope: list[float]
    accelerometer: list[float]
    rpy: list[float]
    temperature: int


@dataclass
class FakePathPoint:
    t_from_start: float
    x: float
    y: float
    yaw: float
    vx: float
    vy: float
    vyaw: float


@dataclass
class FakeSportModeState:
    stamp: FakeTimeSpec
    error_code: int
    imu_state: FakeImuState
    mode: int
    progress: float
    gait_type: int
    foot_raise_height: float
    position: list[float]
    body_height: float
    velocity: list[float]
    yaw_speed: float
    range_obstacle: list[float]
    foot_force: list[int]
    foot_position_body: list[float]
    foot_speed_body: list[float]
    path_point: list[FakePathPoint]


def test_build_dds_msg_supports_struct_style_message_types():
    module = load_sim_module()

    msg = module.build_dds_msg(
        FakeSportModeState,
        1.25,
        -0.5,
        0.32,
        1.57,
        TimeSpecType=FakeTimeSpec,
        IMUStateType=FakeImuState,
        PathPointType=FakePathPoint,
    )

    assert msg.position == [1.25, -0.5, 0.32]
    assert msg.imu_state.rpy == [0.0, 0.0, 1.57]
    assert msg.body_height == 0.32
    assert len(msg.path_point) == 10
    assert all(p.x == 1.25 and p.y == -0.5 for p in msg.path_point)
