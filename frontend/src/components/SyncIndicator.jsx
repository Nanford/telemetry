/**
 * INPUT: api.js 的 getConnectionStatus() / onConnectionChange() 链路状态快照
 * OUTPUT: SyncIndicator（顶栏数据新鲜度）、LinkSignal（侧边栏链路状态）
 * POS: 全局数据可信度指示。二者各自承担 1Hz 计时，
 *      避免把每秒重渲染扩散到整棵路由树（地图/热力图重绘代价高）。
 */
import React, { useEffect, useState } from 'react';
import { getConnectionStatus, onConnectionChange } from '../api.js';

const TICK_MS = 1000;
// 各页面轮询最快 15s、最慢 30s，60s 未更新即可判定异常。
const WARN_AFTER_MS = 60 * 1000;
const ALERT_AFTER_MS = 5 * 60 * 1000;

const formatAge = (ms) => {
  if (ms === null) return '--';
  if (ms < 5000) return '刚刚';
  if (ms < 60 * 1000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))} 分钟前`;
  return `${Math.floor(ms / (60 * 60 * 1000))} 小时前`;
};

/**
 * 订阅链路状态并按秒推进时间基准。
 * tone: ok(新鲜) / warn(延迟) / alert(陈旧或降级到 mock) / offline(从未成功)
 */
const useFreshness = () => {
  const [status, setStatus] = useState(getConnectionStatus);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onConnectionChange(setStatus), []);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      // notify() 只在 mock↔真实切换时广播，而首次加载是 false→false（没切换），
      // 只靠订阅的话 lastSuccessAt 永远停在 null，链路正常反而显示"尚未连接"。
      // 这里借已有的 1Hz 计时顺手拉一次快照；没变化就返回原对象，不产生额外渲染。
      setStatus((prev) => {
        const next = getConnectionStatus();
        return prev.lastSuccessAt === next.lastSuccessAt && prev.isMock === next.isMock
          ? prev
          : next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const { isMock, lastSuccessAt } = status;
  const ageMs = lastSuccessAt === null ? null : Math.max(0, now - lastSuccessAt);

  let tone = 'ok';
  if (ageMs === null) tone = 'offline';
  else if (isMock || ageMs >= ALERT_AFTER_MS) tone = 'alert';
  else if (ageMs >= WARN_AFTER_MS) tone = 'warn';

  return { tone, ageMs, isMock };
};

export const SyncIndicator = () => {
  const { tone, ageMs, isMock } = useFreshness();
  const detail =
    ageMs === null
      ? '尚未取到后端数据'
      : `${formatAge(ageMs)}${isMock ? ' · 当前展示模拟数据' : ''}`;

  return (
    <div className={`topbar-subtitle sync-indicator tone-${tone}`}>
      <span className="sync-dot" />
      数据同步 · <span className="sync-age">{detail}</span>
    </div>
  );
};

export const LinkSignal = () => {
  const { tone, ageMs, isMock } = useFreshness();

  const titleByTone = {
    offline: '尚未连接',
    alert: isMock ? '连接异常' : '数据已陈旧',
    warn: '同步延迟',
    ok: '数据链路'
  };
  const subtitle =
    tone === 'offline'
      ? '等待首次响应'
      : isMock
        ? '请检查后端服务'
        : `最后同步 ${formatAge(ageMs)}`;

  return (
    <div className="signal">
      <span className={`signal-dot tone-${tone}`} />
      <div>
        <div className="signal-title">{titleByTone[tone]}</div>
        <div className="signal-subtitle">{subtitle}</div>
      </div>
    </div>
  );
};
