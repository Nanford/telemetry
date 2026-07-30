/**
 * INPUT: useSvgZoom 返回的 zoom 对象。
 * OUTPUT: 悬浮在平面图右上角的 ＋ / － / 倍率(点击复位) 三个按钮。
 * POS: 热力图 / 巡检地图 / 批次详情图共用的缩放控件。放在 position:relative 的容器内即可定位。
 */
import React from 'react';

// 倍率读数：trailing zero 去掉，0.75 显示成 0.75× 而不是被 toFixed(1) 抹成 0.8×
const formatScale = (scale) => `${Number(scale.toFixed(2))}×`;

const MapZoomControls = ({ zoom, className = '' }) => (
  <div
    className={`map-zoom-controls ${className}`.trim()}
    role="group"
    aria-label="地图缩放"
  >
    <button
      type="button"
      aria-label="放大"
      title="放大"
      onClick={zoom.zoomIn}
      disabled={zoom.scale >= zoom.maxScale}
    >
      ＋
    </button>
    <button
      type="button"
      aria-label="缩小"
      title="缩小"
      onClick={zoom.zoomOut}
      disabled={zoom.scale <= zoom.minScale}
    >
      －
    </button>
    {/* 倍率同时充当复位按钮：既显示当前状态，又不用再占一格。
        1× 既不是最大也不是最小，所以按「是否偏离 1×」判断能否复位，不能用放大与否 */}
    <button
      type="button"
      className="map-zoom-reset"
      aria-label={`当前 ${formatScale(zoom.scale)}，点击复位到全览`}
      title="复位到全览（1×）"
      onClick={zoom.reset}
      disabled={!zoom.canReset}
    >
      {formatScale(zoom.scale)}
    </button>
  </div>
);

export default MapZoomControls;
