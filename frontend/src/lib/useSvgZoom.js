/**
 * INPUT: baseWidth / baseHeight —— 未缩放时 SVG viewBox 的完整范围（用户坐标，不是像素）。
 * OUTPUT: useSvgZoom Hook —— 受控 viewBox 字符串、要绑到 <svg> 上的 props、缩放/复位操作，
 *         以及 shouldIgnoreClick()（刚拖拽完时吞掉这一次 click）。
 * POS: 热力图 / 巡检地图 / 批次详情图三张平面图共用的缩放平移逻辑。
 *      缩放走 viewBox 而不是 CSS transform：文字、线宽、图元全程保持矢量清晰，
 *      且点击命中坐标由浏览器自动换算，组件不需要为缩放改任何绘图代码。
 *
 * 交互范围：＋/－/复位 三个按钮 + 放大后按住拖拽平移。
 * 不做滚轮缩放 —— 地图在长页面里占很大一块，劫持滚轮会让光标扫过地图时页面滚不动。
 *
 * 1× 是「整张图刚好铺满容器」。放大和缩小走的是两套机制：
 *   · scale > 1：收窄 viewBox，容器尺寸不变 —— 看细节，可拖拽平移。
 *   · scale < 1：viewBox 保持全览，改为按比例收窄容器（frameStyle）——
 *     整张卡片跟着变矮，页面真正变紧凑。若这里也去放大 viewBox，
 *     结果只是图在原地缩小、四周空出一圈，卡片照样占那么高，等于没缩。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MIN_SCALE = 0.5;
const DEFAULT_MAX_SCALE = 8;
// 1× = 全览，是缩放的基准点：放大/缩小两套机制以它为界，复位也回到它
const BASE_SCALE = 1;
// 放大段每次的倍率
const STEP = 1.35;
// 缩小段用固定档位而不是连乘 STEP：连乘会排出 0.74 / 0.55 / 0.5 三档，
// 相邻两档肉眼几乎没差别，标签四舍五入后还都显示「0.5×」，点了像没反应。
const SHRINK_STEPS = [0.5, 0.75];  // 升序，1× 由 BASE_SCALE 补在末尾
// 浮点连乘/连除回不到精确的 1，用它把接近 1 的结果吸附回基准
const EPSILON = 1e-6;

/**
 * viewBox 实际使用的放大倍数。1× 以下一律按 1 处理：
 * 那一段靠收窄容器实现，viewBox 必须停在全览，否则会两头都缩、图小得离谱。
 */
const viewLevel = (scale) => Math.max(BASE_SCALE, scale);

/** 下一档缩小值：放大段按 STEP 连除，1× 及以下走固定档位。 */
const scaleDown = (scale) => {
  if (scale > BASE_SCALE) {
    const next = scale / STEP;
    return next <= BASE_SCALE + EPSILON ? BASE_SCALE : next;
  }
  const lower = SHRINK_STEPS.filter((step) => step < scale - EPSILON);
  return lower.length ? lower[lower.length - 1] : scale;
};

/** 下一档放大值：1× 以下先逐档回到 1×，之后才按 STEP 连乘。 */
const scaleUp = (scale) => {
  if (scale >= BASE_SCALE - EPSILON) return scale * STEP;
  const higher = [...SHRINK_STEPS, BASE_SCALE].filter((step) => step > scale + EPSILON);
  return higher.length ? higher[0] : BASE_SCALE;
};
// 指针位移超过这个像素数才算拖拽；低于阈值仍按点击处理，否则手抖会选不中测点
const DRAG_THRESHOLD_PX = 4;

const IDENTITY = { scale: BASE_SCALE, x: 0, y: 0 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 视口左上角的可行域：放大后视野变小，原点最多推到「图右下角刚好贴住视口右下角」。
 * 一律按 viewLevel 算 —— 直接拿 scale=0.5 代入会得到负的上界，clamp 会把原点推成负数。
 */
const clampOrigin = (x, y, scale, baseWidth, baseHeight) => {
  const level = viewLevel(scale);
  return {
    x: clamp(x, 0, baseWidth - baseWidth / level),
    y: clamp(y, 0, baseHeight - baseHeight / level)
  };
};

/** 纯函数：以当前视口中心为不动点缩放到 rawScale，并把视口夹回图内。 */
const zoomToScale = (view, rawScale, baseWidth, baseHeight, maxScale) => {
  const scale = clamp(rawScale, MIN_SCALE, maxScale);
  if (scale === view.scale) return view;

  const focusX = view.x + baseWidth / viewLevel(view.scale) / 2;
  const focusY = view.y + baseHeight / viewLevel(view.scale) / 2;
  // 中心点缩放前后落在同一屏幕位置：origin' = focus - (focus - origin) * (scale / scale')
  const ratio = viewLevel(view.scale) / viewLevel(scale);
  return {
    scale,
    ...clampOrigin(
      focusX - (focusX - view.x) * ratio,
      focusY - (focusY - view.y) * ratio,
      scale,
      baseWidth,
      baseHeight
    )
  };
};

export const useSvgZoom = ({ baseWidth, baseHeight, maxScale = DEFAULT_MAX_SCALE }) => {
  // 用 state 存 DOM 节点而不是 useRef：SVG 可能在「加载中」占位之后才挂载，
  // state 变更能保证依赖它的计算拿到的是真实节点。
  const [svgElement, setSvgElement] = useState(null);
  const [view, setView] = useState(IDENTITY);
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const draggedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const usable = Number.isFinite(baseWidth) && Number.isFinite(baseHeight)
    && baseWidth > 0 && baseHeight > 0;

  const svgRef = useCallback((node) => setSvgElement(node), []);

  // 换库房 / 换批次时基准尺寸会变，沿用旧偏移会把新图推出视野，直接回到全览
  useEffect(() => {
    setView(IDENTITY);
  }, [baseWidth, baseHeight]);

  /** 一个用户坐标单位对应多少屏幕像素，用于把拖拽的像素位移换算回图上距离。 */
  const pixelsPerUnit = useCallback(() => {
    const matrix = svgElement?.getScreenCTM?.();
    if (matrix && matrix.a) return matrix.a;
    const rect = svgElement?.getBoundingClientRect?.();
    if (rect?.width) return rect.width / (baseWidth / viewLevel(viewRef.current.scale));
    return 1;
  }, [svgElement, baseWidth]);

  // 组件卸载时兜底解绑：正常路径在 pointerup 就解了，这里防的是拖拽中途被卸载
  const unbindPanRef = useRef(null);
  useEffect(() => () => unbindPanRef.current?.(), []);

  const handlePointerDown = useCallback((event) => {
    // 已在拖拽中就忽略后来的指针（双指触摸、拖拽途中再按一个键）。
    // 否则会同时挂上两套 move 处理器互相覆盖 setView，画面抖动；
    // 这个判断必须排在 draggedRef 复位之前，不然第二根手指会把
    // 「本次是拖拽」的标记抹掉，松手后那一下点击就漏过去了。
    if (panRef.current) return;
    // 无论这次能不能拖，都要先清掉上一次的拖拽标记，
    // 否则「拖过一次 → 复位到 1x → 再点测点」会被误判成拖拽而选不中。
    draggedRef.current = false;
    // 只有放大到 1× 以上才有可平移的余量；缩小段整张图本就全在视野里
    if (!usable || event.button !== 0 || viewRef.current.scale <= BASE_SCALE) return;

    const pan = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: { x: viewRef.current.x, y: viewRef.current.y },
      ppu: pixelsPerUnit()  // 拖拽期间比例不变，按下时算一次即可
    };
    panRef.current = pan;

    // 位移始终按「相对按下点」算，而不是逐帧累加，所以丢帧不会造成漂移
    const handleMove = (moveEvent) => {
      // 监听挂在 window 上，收得到所有指针的事件。不认指针 id 的话，
      // 双指触摸时第二根手指的滑动会驱动第一根手指的平移。
      if (moveEvent.pointerId !== pan.pointerId) return;
      const dx = moveEvent.clientX - pan.clientX;
      const dy = moveEvent.clientY - pan.clientY;
      if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;
      setView((current) => ({
        ...current,
        ...clampOrigin(
          pan.origin.x - dx / pan.ppu,
          pan.origin.y - dy / pan.ppu,
          current.scale,
          baseWidth,
          baseHeight
        )
      }));
    };

    const unbind = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      unbindPanRef.current = null;
    };

    // 同理只认自己那根手指的抬起；别的指针抬起不该结束本次拖拽
    function handleUp(upEvent) {
      if (upEvent.pointerId !== pan.pointerId) return;
      unbind();
      panRef.current = null;
      setPanning(false);
    }

    // 监听挂在 window 上、且在 pointerdown 里立即绑定：
    //   · 挂 window 而不是 setPointerCapture —— 一旦捕获指针，后续 click 会被派发到
    //     捕获元素(<svg>)而不是测点 <g>，点位选中会整体失效；挂 window 既能拖出画布，
    //     又不影响 click 的目标元素。
    //   · 立即绑定而不是放进依赖 panning 的 effect —— effect 要等 React 重渲染才执行，
    //     极快的「按下-拖动-松开」整段会落在渲染之前，平移丢失、panning 还会卡住。
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    unbindPanRef.current = unbind;

    setPanning(true);
  }, [usable, pixelsPerUnit, baseWidth, baseHeight]);

  const zoomIn = useCallback(() => {
    setView((current) => zoomToScale(current, scaleUp(current.scale), baseWidth, baseHeight, maxScale));
  }, [baseWidth, baseHeight, maxScale]);

  const zoomOut = useCallback(() => {
    setView((current) => zoomToScale(current, scaleDown(current.scale), baseWidth, baseHeight, maxScale));
  }, [baseWidth, baseHeight, maxScale]);

  const reset = useCallback(() => setView(IDENTITY), []);

  /** 供测点 onClick 调用：刚结束的是一次拖拽，就别把它当成选中操作。 */
  const shouldIgnoreClick = useCallback(() => draggedRef.current, []);

  const level = viewLevel(view.scale);
  const viewBox = usable
    ? `${view.x} ${view.y} ${baseWidth / level} ${baseHeight / level}`
    : `0 0 ${baseWidth || 1} ${baseHeight || 1}`;

  // 放大段才可拖拽；缩小段整张图都在视野里，没有可平移的余量
  const isPannable = view.scale > BASE_SCALE;

  const svgProps = useMemo(() => ({
    ref: svgRef,
    onPointerDown: handlePointerDown,
    style: {
      cursor: isPannable ? (panning ? 'grabbing' : 'grab') : 'default',
      // 放大后触屏拖拽用于平移；其余情况保持 auto，否则移动端在地图上划不动页面
      touchAction: isPannable ? 'none' : 'auto',
      userSelect: panning ? 'none' : undefined
    }
  }), [svgRef, handlePointerDown, isPannable, panning]);

  // 缩小段：按比例收窄「直接包住 svg 的那一层」，其高度由 svg 的 height:auto 跟着变矮。
  // 注意缩放控件必须锚在这一层之外的固定尺寸容器上，否则图一缩按钮就跟着往里跑。
  // 画布高度靠 aspect-ratio 决定的图（批次详情图）不用这个，见 InspectionRouteMap。
  const frameStyle = useMemo(() => (
    view.scale < BASE_SCALE ? { width: `${view.scale * 100}%` } : undefined
  ), [view.scale]);

  return {
    viewBox,
    svgProps,
    frameStyle,
    scale: view.scale,
    minScale: MIN_SCALE,
    maxScale,
    isPannable,
    canReset: view.scale !== BASE_SCALE,
    zoomIn,
    zoomOut,
    reset,
    shouldIgnoreClick
  };
};

export default useSvgZoom;
