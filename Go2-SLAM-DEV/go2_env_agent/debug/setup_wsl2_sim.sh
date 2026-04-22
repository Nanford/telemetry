#!/usr/bin/env bash
# ============================================================
# WSL2 一键部署 Go2 模拟器环境
# 在 WSL2 Debian 终端中执行:
#   cd /mnt/c/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent
#   bash debug/setup_wsl2_sim.sh
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

VENV_DIR="$HOME/go2_sim_venv"
CYCLONE_VER="0.10.2"
BUILD_DIR="$HOME/build_cyclonedds"

# ── 1. 系统依赖 ─────────────────────────────────────────────
info "安装系统依赖..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    cmake build-essential \
    libffi-dev libssl-dev zlib1g-dev \
    libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev libgdbm-dev liblzma-dev \
    tk-dev uuid-dev wget curl git

# ── 2. 编译 Python 3.11 (如果没有) ──────────────────────────
if command -v python3.11 &>/dev/null; then
    info "Python 3.11 已存在: $(python3.11 --version)"
else
    info "编译安装 Python 3.11..."
    PY_VER="3.11.12"
    cd /tmp
    wget -q "https://www.python.org/ftp/python/${PY_VER}/Python-${PY_VER}.tgz"
    tar xzf "Python-${PY_VER}.tgz"
    cd "Python-${PY_VER}"
    ./configure --enable-optimizations --prefix=/usr/local 2>&1 | tail -3
    make -j"$(nproc)" 2>&1 | tail -3
    sudo make altinstall 2>&1 | tail -3
    cd /tmp && rm -rf "Python-${PY_VER}" "Python-${PY_VER}.tgz"
    info "Python 3.11 安装完成: $(python3.11 --version)"
fi

# ── 3. 编译 CycloneDDS C 库 ─────────────────────────────────
if [ -f "$BUILD_DIR/install/lib/libddsc.so" ]; then
    info "CycloneDDS C 库已存在，跳过编译"
else
    info "编译 CycloneDDS C 库 ${CYCLONE_VER}..."
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    if [ ! -d cyclonedds ]; then
        # 0.10.2 is published as a tag; releases/0.10.2 is not a valid branch.
        git clone --branch "${CYCLONE_VER}" --depth 1 \
            https://github.com/eclipse-cyclonedds/cyclonedds.git
    fi
    mkdir -p cyclonedds/build && cd cyclonedds/build
    cmake -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/install" \
          -DBUILD_EXAMPLES=OFF \
          -DBUILD_TESTING=OFF \
          -DBUILD_DDSPERF=OFF \
          .. 2>&1 | tail -5
    make -j"$(nproc)" ddsc 2>&1 | tail -3
    make install 2>&1 | tail -3
    info "CycloneDDS C 库编译完成"
fi

export CYCLONEDDS_HOME="$BUILD_DIR/install"

# ── 4. 创建 venv 并安装 Python 包 ───────────────────────────
if [ -d "$VENV_DIR" ]; then
    info "虚拟环境已存在: $VENV_DIR"
else
    info "创建 Python 3.11 虚拟环境..."
    python3.11 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q

info "安装 cyclonedds Python 绑定..."
CYCLONEDDS_HOME="$BUILD_DIR/install" pip install cyclonedds==${CYCLONE_VER} -q

info "安装 unitree_sdk2_python..."
if [ ! -d "$BUILD_DIR/unitree_sdk2_python" ]; then
    cd "$BUILD_DIR"
    git clone --depth 1 https://github.com/unitreerobotics/unitree_sdk2_python.git
fi
cd "$BUILD_DIR/unitree_sdk2_python"
# 修复 b2 导入错误
INIT_FILE="unitree_sdk2py/idl/__init__.py"
if [ -f "$INIT_FILE" ] && grep -q "from .unitree_hg" "$INIT_FILE"; then
    sed -i '/from .unitree_hg/d' "$INIT_FILE"
    info "已修复 unitree_sdk2py b2/hg 导入"
fi
pip install -e . -q

info "安装其他依赖..."
pip install numpy -q

# ── 5. 验证 ─────────────────────────────────────────────────
info "验证安装..."
python3 -c "import importlib.metadata as metadata; import cyclonedds; print(f\"  cyclonedds: {metadata.version('cyclonedds')} ({cyclonedds.__file__})\")"
python3 -c "from unitree_sdk2py.core.channel import ChannelPublisher; print('  unitree_sdk2py: OK')"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} 部署完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "使用方法:"
echo "  source $VENV_DIR/bin/activate"
echo "  cd /mnt/c/Users/nanfo/Desktop/Go2-SLAM-DEV/go2_env_agent"
echo ""
echo "  # 跑模拟器 (DDS, lo 回环)"
echo "  python debug/sim_go2_dog.py --transport dds --iface lo --mode patrol"
echo ""
echo "  # 另一个终端跑 agent"
echo "  source $VENV_DIR/bin/activate"
echo "  export GO2_NET_IFACE=lo"
echo "  # ... 设置其他环境变量后"
echo "  python -m app.main"
