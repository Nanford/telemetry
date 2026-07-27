/**
 * CAD 仓间入口图元。
 *
 * 根据 door.wall 在四面墙上绘制正确方向的门洞、开启弧和入口标识，避免把东门
 * 继续按旧版南门横向显示。fx/fy 由宿主地图提供，保证所有地图使用同一坐标投影。
 */
import React from 'react';

const numberOr = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const WALL_LABELS = {
  east: '东门',
  west: '西门',
  north: '北门',
  south: '南门'
};

const CadDoor = ({
  door,
  fx,
  fy,
  background = '#061326',
  stroke = '#80d5ff',
  labelFill = '#9fe6ff'
}) => {
  if (!door) return null;

  const x = fx(numberOr(door.x, 0));
  const y = fy(numberOr(door.y, 0));
  const width = Math.max(0.8, numberOr(door.width, 4));
  const half = width / 2;
  const wall = String(door.wall || 'south').toLowerCase();
  const label = `${door.label || WALL_LABELS[wall] || '入口'} · 巡检入口`;
  const common = {
    fill: 'none',
    stroke,
    strokeWidth: 0.055,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  };

  if (wall === 'east' || wall === 'west') {
    const inward = wall === 'east' ? -1 : 1;
    const labelX = inward * 0.55;
    const arrowOutside = -inward * 1.15;
    const arrowInside = inward * 0.72;
    const leafX = inward * width;
    const arcSweep = wall === 'east' ? 0 : 1;

    return (
      <g
        transform={`translate(${x} ${y})`}
        data-door-wall={wall}
        aria-label={label}
      >
        <rect
          x="-0.18"
          y={-half}
          width="0.36"
          height={width}
          rx="0.04"
          fill={background}
          stroke={stroke}
          strokeWidth="0.06"
        />
        <line x1="0" y1={-half} x2={leafX} y2={-half} {...common} />
        <path
          d={`M 0 ${half} A ${width} ${width} 0 0 ${arcSweep} ${leafX} ${-half}`}
          {...common}
          strokeOpacity="0.48"
          strokeDasharray="0.16 0.12"
        />
        <path
          d={`M ${arrowOutside} 0 L ${arrowInside} 0 M ${arrowInside} 0 l ${-inward * 0.28} -0.22 M ${arrowInside} 0 l ${-inward * 0.28} 0.22`}
          {...common}
          strokeWidth="0.075"
        />
        <text
          x={labelX}
          y="0.5"
          textAnchor={wall === 'east' ? 'end' : 'start'}
          fontSize="0.34"
          fontWeight="700"
          fill={labelFill}
        >
          {label}
        </text>
      </g>
    );
  }

  const inward = wall === 'north' ? 1 : -1;
  const labelY = inward * 0.68;
  const arrowOutside = -inward * 1.15;
  const arrowInside = inward * 0.72;
  const leafY = inward * width;
  const arcSweep = wall === 'north' ? 1 : 0;

  return (
    <g
      transform={`translate(${x} ${y})`}
      data-door-wall={wall}
      aria-label={label}
    >
      <rect
        x={-half}
        y="-0.18"
        width={width}
        height="0.36"
        rx="0.04"
        fill={background}
        stroke={stroke}
        strokeWidth="0.06"
      />
      <line x1={-half} y1="0" x2={-half} y2={leafY} {...common} />
      <path
        d={`M ${half} 0 A ${width} ${width} 0 0 ${arcSweep} ${-half} ${leafY}`}
        {...common}
        strokeOpacity="0.48"
        strokeDasharray="0.16 0.12"
      />
      <path
        d={`M 0 ${arrowOutside} L 0 ${arrowInside} M 0 ${arrowInside} l -0.22 ${-inward * 0.28} M 0 ${arrowInside} l 0.22 ${-inward * 0.28}`}
        {...common}
        strokeWidth="0.075"
      />
      <text
        x="0"
        y={labelY}
        textAnchor="middle"
        fontSize="0.34"
        fontWeight="700"
        fill={labelFill}
      >
        {label}
      </text>
    </g>
  );
};

export default CadDoor;
