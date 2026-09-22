// 能力评估页的两张图。
//
// 形式的选择：需求文档写的是"能力雷达图"，这里改成条形。七个部分要读的是
// "各部分得分率谁高谁低"，属于比较量值，条形直接可比；雷达图轴序任意、面积
// 会放大差异，同样的数据更难读。
//
// 条形用 HTML 画而不是 SVG：SVG 里的字号会随 viewBox 缩放，实测在 390px 的
// 手机上 12px 的字只剩 7.7px，根本看不清。HTML 的字号不受容器宽度影响。
// 折线仍用 SVG（折线本来就该用矢量画），但 viewBox 收窄到 360，让手机上的
// 缩放比接近 1:1。
// 单序列不需要图例，标题已经说明画的是什么。

/** 七个部分的得分率 */
export function SectionBars({ sections }) {
  const rows = sections.filter((s) => s.rate !== null);
  if (!rows.length) return <p className="small muted">还没有足够的数据。</p>;

  return (
    <div className="stack">
      {rows.map((s) => {
        const pct = Math.round(Math.min(1, Math.max(0, s.rate)) * 100);
        return (
          <div key={s.sectionOrd}>
            <div className="spread" style={{ marginBottom: 4 }}>
              <span className="small">{s.sectionType}</span>
              <span className="small">
                <strong>{pct}%</strong>
                <span className="muted" style={{ marginLeft: 8 }}>
                  预测 {s.predicted} / {s.maxScore}
                </span>
              </span>
            </div>
            <div className="bar" title={`${s.sectionType}：得分率 ${pct}%`}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 历次模考总分。点少，所以每个点都画出来并标值。 */
export function TrendLine({ trend }) {
  const pts = trend.filter((t) => typeof t.score === 'number');
  if (pts.length < 2) return <p className="small muted">至少两次模考才能看出趋势。</p>;

  // viewBox 收窄到 360：手机上几乎 1:1，字号不会被缩没
  const W = 360, H = 170, padL = 32, padR = 14, padT = 24, padB = 26;
  const inset = 14;
  const max = Math.max(100, ...pts.map((p) => p.score));
  const x = (i) => padL + inset + (W - padL - padR - inset * 2) *
    (pts.length === 1 ? 0.5 : i / (pts.length - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.score)}`).join(' ');

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="历次模考总分趋势"
        style={{ width: '100%', maxWidth: 520, display: 'block' }}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            {/* 网格退到背景里，不和数据抢 */}
            <line x1={padL} x2={W - padR} y1={y(max * t)} y2={y(max * t)}
              stroke="var(--line)" strokeWidth="1" />
            <text x={padL - 6} y={y(max * t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--primary)" strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => {
          // 贴近顶部的点，数值改标在下方，不然会顶出画布或压到刻度
          const near = y(p.score) - padT < 14;
          return (
            <g key={i}>
              {/* 白描边把点从折线上托出来 */}
              <circle cx={x(i)} cy={y(p.score)} r="4.5" fill="var(--primary)"
                stroke="#fff" strokeWidth="2">
                <title>{`第 ${i + 1} 次：${p.score} 分`}</title>
              </circle>
              <text x={x(i)} y={y(p.score) + (near ? 17 : -10)} textAnchor="middle"
                fontSize="12" fill="var(--ink)">
                {p.score}
              </text>
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
                第 {i + 1} 次
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
