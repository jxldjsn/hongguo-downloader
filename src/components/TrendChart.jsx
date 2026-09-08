import React, { useState, useEffect, useRef } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Area, AreaChart, Legend,
} from 'recharts';
import './TrendChart.css';

// 监听容器宽度，直到其 > 0 才渲染图表，避免 recharts ResponsiveContainer 的 width(-1) 告警
function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// 通用趋势曲线组件（recharts 封装）
// data: [{ time, value }] | [{ time, diggCount, commentCount }]
// series: [{ key, name, color }]  例如 [{ key: 'value', name: '粉丝', color: 'var(--ops-accent)' }]
// height: px
// showDots: 是否显示数据点标记（默认 true，小变化也能看清每个采样点）
// valueMode: 'absolute'（默认，显示绝对值）| 'delta'（相对首点净增量）| 'percent'（相对首点百分比增幅，
//            让粉丝/获赞/作品数等不同量级序列都能在同一 Y 轴上对比涨跌幅度）
function TrendChart({ data = [], series = [], height = 180, mode = 'line', showDots = true, valueMode = 'absolute' }) {
  const [ref, width] = useContainerWidth();
  const seriesList = Array.isArray(series) ? series : [];
  // 可点击图例：点击某条序列可隐藏/显示，便于单独查看点赞/收藏/分享/评论等
  const [hiddenKeys, setHiddenKeys] = useState(() => new Set());
  const toggleKey = (key) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      // 至少保留一条可见，避免全部隐藏后图变空白
      const wouldHideAll = !next.has(key) && next.size === seriesList.length - 1;
      if (wouldHideAll) return next;
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const visibleSeries = seriesList.filter((s) => s && !hiddenKeys.has(s.key));

  if (!data || data.length === 0) {
    return (
      <div className="trend-empty" style={{ height }}>
        <span>暂无历史数据，等待监控检查后生成曲线</span>
      </div>
    );
  }

  // 单点时补一个稍早的占位点，让 recharts 能画出起伏线段
  const baseData = data.length === 1
    ? [{ ...data[0], time: data[0].time - 1 }, ...data]
    : data;

  // delta / percent 模式：每条序列相对首点做变换，让不同量级的多条线都能同 Y 轴对比
  const chartData = (() => {
    if (valueMode !== 'delta' && valueMode !== 'percent') return baseData;
    const baseline = {};
    for (const s of series) {
      const first = baseData.find((d) => typeof d[s.key] === 'number');
      baseline[s.key] = first ? first[s.key] : 0;
    }
    return baseData.map((d) => {
      const nd = { time: d.time };
      for (const s of series) {
        if (typeof d[s.key] !== 'number') { nd[s.key] = null; continue; }
        if (valueMode === 'delta') {
          nd[s.key] = d[s.key] - baseline[s.key];
        } else {
          // percent：相对首点增幅百分比；首点为 0 时回退为净增量避免除零
          const base = baseline[s.key];
          nd[s.key] = base !== 0 ? ((d[s.key] - base) / Math.abs(base)) * 100 : (d[s.key] - base);
        }
      }
      return nd;
    });
  })();

  const formatX = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const formatY = (n) => {
    if (typeof n !== 'number') return '0';
    if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + 'w';
    return String(n);
  };

  // delta 模式下 Y 轴带正负号格式
  const formatYDelta = (n) => {
    if (typeof n !== 'number') return '0';
    const sign = n > 0 ? '+' : '';
    if (Math.abs(n) >= 100000000) return sign + (n / 100000000).toFixed(1) + '亿';
    if (Math.abs(n) >= 10000) return sign + (n / 10000).toFixed(1) + 'w';
    return sign + String(Math.round(n));
  };

  // percent 模式：Y 轴显示百分比
  const formatYPercent = (n) => {
    if (typeof n !== 'number') return '0';
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  };

  const yTickFormatter = valueMode === 'percent' ? formatYPercent
    : valueMode === 'delta' ? formatYDelta
    : formatY;

  // 计算 Y 轴自适应范围：基于【可见】序列 min/max 上下留 8% 余量，不强制从 0 开始
  // delta/percent 模式下范围天然包含 0（首点），趋势起伏更明显
  // 隐藏某条序列后 Y 轴会重新自适应，避免被大量级序列挤压
  const allValues = chartData.flatMap((d) =>
    visibleSeries.map((s) => d[s.key]).filter((v) => typeof v === 'number')
  );
  let yDomain = ['auto', 'auto'];
  if (allValues.length > 0) {
    const minV = Math.min(...allValues);
    const maxV = Math.max(...allValues);
    if (minV === maxV) {
      // 所有点值相同：上下各留一点空间，避免画成贴边直线
      const pad = Math.max(1, Math.abs(minV) * 0.1);
      yDomain = [minV - pad, maxV + pad];
    } else {
      const span = maxV - minV;
      const pad = span * 0.08;
      // delta/percent 模式允许负值，不强制下限为 0；绝对值模式贴近 0 更直观
      yDomain = (valueMode === 'delta' || valueMode === 'percent')
        ? [minV - pad, maxV + pad]
        : [Math.max(0, minV - pad), maxV + pad];
    }
  }

  const Chart = mode === 'area' ? AreaChart : LineChart;

  // 数据点标记：点少时显示所有点，点多时只显示首尾与极值附近的点（避免拥挤）
  const dotCount = chartData.length;
  const dotConfig = showDots
    ? { r: 3, strokeWidth: 1.5, fill: 'var(--bg-elevated)', stroke: 'var(--ops-accent)' }
    : false;
  // 点很多时改用稀疏点（每 5 个显示一个），保证可读
  const sparseDot = dotCount > 20
    ? (props) => {
        const { index } = props;
        if (index === 0 || index === dotCount - 1) {
          return <circle cx={props.cx} cy={props.cy} r={3} fill="var(--bg-elevated)" stroke={props.stroke} strokeWidth={1.5} />;
        }
        return <g key={`dot-${index}`} />;
      }
    : dotConfig;

  return (
    <div className="trend-chart" style={{ height }} ref={ref}>
      {/* 容器宽度尚未测量到（首帧）时先不渲染 ResponsiveContainer，避免 width(-1) 告警 */}
      {width > 0 && (
        <ResponsiveContainer width={width} height={height}>
          <Chart data={chartData} margin={{ top: 10, right: 16, bottom: 4, left: -4 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-muted)" vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={formatX}
              tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
              stroke="var(--border-default)"
              minTickGap={28}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={yTickFormatter}
              tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
              stroke="var(--border-default)"
              width={48}
            />
            {series.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 4 }}
                iconType="plainline"
                onClick={(o) => {
                  // recharts v3: o.dataKey 可能为 undefined，回退按 name 匹配
                  const key = o.dataKey || (series.find((s) => s.name === o.value)?.key);
                  if (key) toggleKey(key);
                }}
                formatter={(value, entry, index) => {
                  const s = series[index];
                  const hidden = s ? hiddenKeys.has(s.key) : false;
                  return (
                    <span
                      style={{
                        color: hidden ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                        textDecoration: hidden ? 'line-through' : 'none',
                        cursor: 'pointer',
                        opacity: hidden ? 0.5 : 1,
                      }}
                    >
                      {value}
                    </span>
                  );
                }}
              />
            )}
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const ts = Number(label);
                const timeStr = ts ? new Date(ts).toLocaleString('zh-CN') : '';
                // 归一化模式下，同时展示变换值(增幅%/增量)与原始绝对数量
                const showAbsolute = valueMode === 'percent' || valueMode === 'delta';
                const rawPoint = showAbsolute ? baseData.find((d) => d.time === ts) : null;
                return (
                  <div className="trend-tooltip">
                    <div className="trend-tooltip-time">{timeStr}</div>
                    {payload.map((p) => {
                      const absVal = rawPoint ? rawPoint[p.dataKey] : null;
                      return (
                        <div key={p.dataKey} className="trend-tooltip-row">
                          <span className="trend-tooltip-dot" style={{ background: p.color }} />
                          <span className="trend-tooltip-name">{p.name}</span>
                          <span className="trend-tooltip-val">
                            {valueMode === 'delta' ? formatYDelta(p.value)
                              : valueMode === 'percent' ? formatYPercent(p.value)
                              : formatY(p.value)}
                          </span>
                          {showAbsolute && typeof absVal === 'number' && (
                            <span className="trend-tooltip-abs">({formatY(absVal)})</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
            {series.map((s) => {
              const hidden = hiddenKeys.has(s.key);
              return mode === 'area' ? (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={3}
                  fill={`url(#grad-${s.key})`}
                  dot={sparseDot}
                  activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--bg-elevated)', stroke: s.color }}
                  isAnimationActive={false}
                  hide={hidden}
                />
              ) : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={3}
                  dot={sparseDot}
                  activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--bg-elevated)', stroke: s.color }}
                  isAnimationActive={false}
                  hide={hidden}
                />
              );
            })}
          </Chart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// 迷你 sparkline（列表项内嵌，无坐标轴）
// 使用固定尺寸的 LineChart，避免 ResponsiveContainer 在 flex 布局中测量为 -1 的告警
export function Sparkline({ data = [], dataKey = 'value', color = 'var(--ops-accent)', width = 88, height = 30 }) {
  if (!data || data.length < 2) {
    return <div className="spark-empty" style={{ width, height }} />;
  }
  // sparkline 也用自适应 Y 范围，让小波动可见
  const vals = data.map((d) => d[dataKey]).filter((v) => typeof v === 'number');
  let yDomain = ['auto', 'auto'];
  if (vals.length > 0) {
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    if (minV === maxV) {
      const pad = Math.max(1, Math.abs(minV) * 0.1);
      yDomain = [minV - pad, maxV + pad];
    } else {
      const pad = (maxV - minV) * 0.1;
      yDomain = [minV - pad, maxV + pad];
    }
  }
  return (
    <div className="sparkline" style={{ width, height, flexShrink: 0 }}>
      <LineChart width={width} height={height} data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <YAxis domain={yDomain} hide />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}

export default TrendChart;
