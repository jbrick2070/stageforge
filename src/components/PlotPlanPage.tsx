import React from 'react';
import type { PlanPoint } from '../types/show';
import { specToSvgPath, type Path2DSpec } from '../data/equipmentSymbols';
import { truncateToWidth, wrapTextToLines, type PlotPlanModel } from '../data/plotPlan';

interface PlotPlanPageProps {
  plan: PlotPlanModel;
}

const pointsAttr = (pts: readonly PlanPoint[]) => pts.map((p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`).join(' ');

function renderSymbolPaths(
  specs: readonly Path2DSpec[],
  strokeWidth: number,
  isIssue: boolean,
): React.ReactNode {
  const stroke = isIssue ? '#cc0000' : '#111111';
  return specs.map((spec, idx) => {
    const fill =
      spec.fill === 'none'
        ? 'none'
        : spec.fill === 'lens'
          ? isIssue
            ? '#fee2e2'
            : '#e4e4e7'
          : spec.fill === 'accent'
            ? isIssue
              ? '#fca5a5'
              : '#a1a1aa'
            : '#ffffff';
    return (
      <path
        key={idx}
        d={specToSvgPath(spec, false)}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  });
}

/**
 * Pure vector true-scale lighting plot page rendered as inline SVG.
 * Outer SVG user units are exact millimetres (width/height in `mm`); inner nested SVG
 * viewBox is world metres matching `(planW * scale / 1000) x (planH * scale / 1000)` so
 * 100% printing produces exact architectural scale on A4 or Letter landscape.
 */
export const PlotPlanPage: React.FC<PlotPlanPageProps> = ({ plan }) => {
  const { geometry: g, viewBox: vb, scale } = plan;
  const mmToM = (mm: number) => (mm * scale) / 1000;

  // Grid lines inside the metres plan view.
  const gridStep = scale <= 50 ? 1 : scale <= 250 ? 5 : 10;
  const gridXs: number[] = [];
  const startX = Math.ceil(vb.x / gridStep) * gridStep;
  for (let x = startX; x <= vb.x + vb.width; x += gridStep) gridXs.push(x);
  const gridZs: number[] = [];
  const startZ = Math.ceil(vb.y / gridStep) * gridStep;
  for (let z = startZ; z <= vb.y + vb.height; z += gridStep) gridZs.push(z);

  const planBottom = g.planY + g.planH;
  const scaleBarX = g.planX + 1.5;
  const scaleBarY = planBottom + 2.0;
  const scaleBarH = 1.9;

  // Legend layout metrics (mm inside sidebar).
  const sbX = g.sidebarX;
  const sbW = g.sidebarW;
  const legY = g.legendY;
  const legH = g.legendH;
  const legInnerX = sbX + 2;
  const legInnerW = sbW - 4;
  const lineStylesH = plan.legend.hasIssues ? 25.5 : 20.5;
  const lineStylesY = legY + legH - lineStylesH;

  // Title block layout metrics (mm inside sidebar).
  const tbY = g.titleBlockY;
  const tbH = g.titleBlockH;
  const tbInnerX = sbX + 2;
  const disclaimerLines = wrapTextToLines(plan.titleBlock.disclaimer, sbW - 4.5, 1.8, false);

  // Build alternating segments for the scale bar up to the max tick.
  const barSegments: Array<{ x: number; w: number; dark: boolean }> = [];
  const stepM = plan.scaleBar.maxMetres >= 10 ? 1 : 0.5;
  const segCount = Math.round(plan.scaleBar.maxMetres / stepM);
  for (let i = 0; i < segCount; i++) {
    const x0 = scaleBarX + ((i * stepM * 1000) / scale);
    const segW = (stepM * 1000) / scale;
    barSegments.push({ x: x0, w: segW, dark: i % 2 === 0 });
  }

  const noticeFontMm = plan.bottomNoticeLines.length > 2 ? 1.5 : 1.65;
  const noticeLineH = plan.bottomNoticeLines.length > 2 ? 2.15 : 2.5;
  const noticeStartY = planBottom + 10.6;

  return (
    <svg
      className="plot-svg"
      data-testid="plot-plan-svg"
      data-paper={plan.paper}
      data-scale={scale}
      data-page-width-mm={g.pageW}
      data-page-height-mm={g.pageH}
      xmlns="http://www.w3.org/2000/svg"
      width={`${g.pageW}mm`}
      height={`${g.pageH}mm`}
      viewBox={`0 0 ${g.pageW} ${g.pageH}`}
      role="img"
      aria-label={`Lighting plot plan for ${plan.titleBlock.rigNameFull}, scale ${plan.titleBlock.scaleLabel}, ${plan.paper.toUpperCase()} landscape`}
      style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", fontVariantNumeric: 'tabular-nums' }}
    >
      {/* Solid white sheet & crisp architectural outer frame */}
      <rect x={0} y={0} width={g.pageW} height={g.pageH} fill="#ffffff" />
      <rect
        x={0.3}
        y={0.3}
        width={g.pageW - 0.6}
        height={g.pageH - 0.6}
        fill="none"
        stroke="#111111"
        strokeWidth={0.45}
      />

      {/* Top band: title + Upstage / North arrow */}
      <g className="plot-top-band">
        <text
          x={g.planX + 1}
          y={5.3}
          fontSize={2.8}
          fontWeight={700}
          fill="#111111"
          letterSpacing={0.2}
        >
          LIGHTING PLOT — PLAN VIEW
        </text>
        <text
          x={g.planX + 58}
          y={5.3}
          fontSize={2.1}
          fill="#444444"
        >
          {`Scale ${plan.titleBlock.scaleLabel} · ${gridStep} m grid · ${plan.geometry.paperLabel} landscape`}
        </text>

        {/* Upstage / North directional arrow */}
        <g data-testid="plot-upstage-arrow" transform={`translate(${g.planX + g.planW - 24}, 1.4)`}>
          <circle cx={3} cy={3} r={2.5} fill="#ffffff" stroke="#111111" strokeWidth={0.25} />
          <polygon points="3,0.9 4.2,4.4 3,3.6 1.8,4.4" fill="#111111" />
          <text x={7.2} y={3.8} fontSize={2.2} fontWeight={700} fill="#111111">
            UPSTAGE
          </text>
        </g>
      </g>

      {/* True-scale nested plan SVG in world metres */}
      <svg
        className="plot-plan-metres"
        data-testid="plot-plan-metres"
        data-scale={scale}
        data-plan-width-mm={g.planW}
        data-plan-height-mm={g.planH}
        data-viewbox-width-m={vb.width}
        data-viewbox-height-m={vb.height}
        x={g.planX}
        y={g.planY}
        width={g.planW}
        height={g.planH}
        viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x={vb.x} y={vb.y} width={vb.width} height={vb.height} fill="#ffffff" />

        {/* Metric grid */}
        <g className="plot-grid">
          {gridXs.map((x) => (
            <line
              key={`gx-${x}`}
              x1={x}
              y1={vb.y}
              x2={x}
              y2={vb.y + vb.height}
              stroke={Math.abs(x) < 1e-6 ? '#cbd5e1' : '#eceff3'}
              strokeWidth={mmToM(Math.abs(x) < 1e-6 ? 0.2 : 0.12)}
              strokeDasharray={Math.abs(x) < 1e-6 ? `${mmToM(2.5)} ${mmToM(1.5)}` : undefined}
            />
          ))}
          {gridZs.map((z) => (
            <line
              key={`gz-${z}`}
              x1={vb.x}
              y1={z}
              x2={vb.x + vb.width}
              y2={z}
              stroke={Math.abs(z) < 1e-6 ? '#cbd5e1' : '#eceff3'}
              strokeWidth={mmToM(Math.abs(z) < 1e-6 ? 0.2 : 0.12)}
              strokeDasharray={Math.abs(z) < 1e-6 ? `${mmToM(2.5)} ${mmToM(1.5)}` : undefined}
            />
          ))}
        </g>

        {/* Stage decks */}
        <g className="plot-decks" data-testid="plot-decks">
          {plan.decks.map((d) => (
            <rect
              key={d.id}
              x={d.x - d.width / 2}
              y={d.z - d.depth / 2}
              width={d.width}
              height={d.depth}
              fill="#fafafa"
              stroke="#52525b"
              strokeWidth={mmToM(0.32)}
              strokeDasharray={`${mmToM(2.2)} ${mmToM(1.2)}`}
            />
          ))}
        </g>

        {/* LED walls */}
        <g className="plot-walls" data-testid="plot-walls">
          {plan.walls.map((w) => (
            <g key={w.id} data-plot-wall={w.id}>
              <polygon
                points={pointsAttr(w.quad)}
                fill="#d4d4d8"
                stroke="#18181b"
                strokeWidth={mmToM(0.45)}
                strokeLinejoin="round"
              />
              <line
                x1={w.center.x}
                y1={w.center.z}
                x2={w.frontTip.x}
                y2={w.frontTip.z}
                stroke="#18181b"
                strokeWidth={mmToM(0.24)}
              />
            </g>
          ))}
        </g>

        {/* PA hangs */}
        <g className="plot-hangs" data-testid="plot-hangs">
          {plan.hangs.map((h) => (
            <g key={`hang-${h.index}`} data-plot-hang={h.index}>
              <polygon
                points={pointsAttr(h.quad)}
                fill="#e4e4e7"
                stroke="#27272a"
                strokeWidth={mmToM(0.35)}
                strokeLinejoin="round"
              />
              <line
                x1={h.center.x}
                y1={h.center.z}
                x2={h.aimTip.x}
                y2={h.aimTip.z}
                stroke="#27272a"
                strokeWidth={mmToM(0.26)}
                strokeLinecap="round"
              />
            </g>
          ))}
        </g>

        {/* Overhead trusses */}
        <g className="plot-trusses" data-testid="plot-trusses">
          {plan.trusses.map((t) =>
            t.circle ? (
              <circle
                key={t.id}
                data-plot-truss={t.id}
                cx={t.circle.cx}
                cy={t.circle.cz}
                r={t.circle.r}
                fill="none"
                stroke="#111111"
                strokeWidth={mmToM(0.55)}
              />
            ) : t.closed ? (
              <polygon
                key={t.id}
                data-plot-truss={t.id}
                points={pointsAttr(t.points)}
                fill="none"
                stroke="#111111"
                strokeWidth={mmToM(0.55)}
                strokeLinejoin="round"
              />
            ) : (
              <polyline
                key={t.id}
                data-plot-truss={t.id}
                points={pointsAttr(t.points)}
                fill="none"
                stroke="#111111"
                strokeWidth={mmToM(0.55)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ),
          )}
        </g>

        {/* Fixture symbols (positions, numbers and statuses strictly from ShowPaperwork) */}
        <g className="plot-fixtures" data-testid="plot-fixtures">
          {plan.fixtures.map((f) => {
            const isIssue = f.status !== 'ok';
            const deg = (-f.yaw * 180) / Math.PI;
            const ringR = Math.max(f.symbol.size.w, f.symbol.size.d) * 0.62 + mmToM(0.35);
            return (
              <g
                key={f.fixtureNumber}
                data-plot-fixture={f.fixtureNumber}
                data-fixture-number={f.fixtureNumber}
                data-dmx-label={f.dmxLabel}
                data-status={f.status}
                transform={`translate(${f.x} ${f.z}) rotate(${deg})`}
              >
                {isIssue && (
                  <circle
                    cx={0}
                    cy={0}
                    r={ringR}
                    fill="none"
                    stroke="#cc0000"
                    strokeWidth={mmToM(0.35)}
                    strokeDasharray={`${mmToM(1.0)} ${mmToM(0.55)}`}
                  />
                )}
                {renderSymbolPaths(f.symbol.plan, mmToM(0.24), isIssue)}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Plan frame border drawn in mm layer */}
      <rect
        x={g.planX}
        y={g.planY}
        width={g.planW}
        height={g.planH}
        fill="none"
        stroke="#666666"
        strokeWidth={0.28}
      />

      {/* Outer mm overlay: collision-reserved structure captions + fixture labels & leader lines */}
      <g className="plot-annotations">
        {plan.captions.map((cap) => (
          <text
            key={cap.id}
            data-plot-caption={cap.id}
            x={cap.x}
            y={cap.y}
            fontSize={cap.fontSize}
            fontWeight={600}
            textAnchor={cap.anchor}
            fill={cap.kind === 'truss' ? '#52525b' : '#3f3f46'}
          >
            {cap.text}
          </text>
        ))}

        {/* Fixture labels & leader lines */}
        <g className="plot-fixture-labels" data-testid="plot-fixture-labels">
          {plan.fixtures.map((f) => {
            const { label } = f;
            const isIssue = f.status !== 'ok';
            const primaryDisplay = label.primaryText;
            const textColor = isIssue ? '#cc0000' : '#111111';
            const subColor = isIssue ? '#cc0000' : '#3f3f46';
            return (
              <g
                key={`lbl-${f.fixtureNumber}`}
                data-label-fixture={f.fixtureNumber}
                data-label-mode={label.mode}
              >
                {label.leader && (
                  <line
                    x1={label.leader.x1}
                    y1={label.leader.y1}
                    x2={label.leader.x2}
                    y2={label.leader.y2}
                    stroke={isIssue ? '#cc0000' : '#52525b'}
                    strokeWidth={0.16}
                  />
                )}
                {!label.forcedInside && label.mode !== 'inside' && (
                  <rect
                    x={label.box.x}
                    y={label.box.y}
                    width={label.box.w}
                    height={label.box.h}
                    rx={0.35}
                    fill="#ffffff"
                    fillOpacity={0.92}
                    stroke={isIssue ? '#cc0000' : '#d4d4d8'}
                    strokeWidth={isIssue ? 0.2 : 0.12}
                  />
                )}
                {label.secondaryText ? (
                  <>
                    <text
                      x={label.textX}
                      y={label.textY - 0.35}
                      fontSize={1.95}
                      fontWeight={700}
                      textAnchor="middle"
                      fill={textColor}
                      stroke={label.forcedInside || label.mode === 'inside' ? '#ffffff' : 'none'}
                      strokeWidth={label.forcedInside || label.mode === 'inside' ? 0.45 : 0}
                      paintOrder="stroke"
                    >
                      {primaryDisplay}
                    </text>
                    <text
                      x={label.textX}
                      y={label.textY + 1.35}
                      fontSize={1.4}
                      fontWeight={500}
                      textAnchor="middle"
                      fill={subColor}
                      stroke={label.forcedInside || label.mode === 'inside' ? '#ffffff' : 'none'}
                      strokeWidth={label.forcedInside || label.mode === 'inside' ? 0.35 : 0}
                      paintOrder="stroke"
                    >
                      {label.secondaryText}
                    </text>
                  </>
                ) : (
                  <text
                    x={label.textX}
                    y={label.textY + 0.65}
                    fontSize={1.75}
                    fontWeight={700}
                    textAnchor="middle"
                    fill={textColor}
                    stroke={label.forcedInside ? '#ffffff' : 'none'}
                    strokeWidth={label.forcedInside ? 0.5 : 0}
                    paintOrder="stroke"
                  >
                    {primaryDisplay}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </g>

      {/* Bottom band: architectural scale bar, DOWNSTAGE / AUDIENCE marker & notices */}
      <g className="plot-bottom-band">
        {/* True-scale bar */}
        <g data-testid="plot-scale-bar">
          {barSegments.map((seg, i) => (
            <rect
              key={i}
              x={seg.x}
              y={scaleBarY}
              width={seg.w}
              height={scaleBarH}
              fill={seg.dark ? '#111111' : '#ffffff'}
              stroke="#111111"
              strokeWidth={0.18}
            />
          ))}
          {/* Exact-width measurement rects for each labelled tick (1 m, 5 m, 10 m) */}
          {plan.scaleBar.ticks.map((tick) => (
            <g key={tick.metres}>
              <rect
                data-scalebar-tick={tick.metres}
                x={scaleBarX}
                y={scaleBarY}
                width={tick.widthMm}
                height={scaleBarH}
                fill="none"
                stroke="#111111"
                strokeWidth={0.22}
              />
              <line
                x1={scaleBarX + tick.widthMm}
                y1={scaleBarY}
                x2={scaleBarX + tick.widthMm}
                y2={scaleBarY + scaleBarH + 1.0}
                stroke="#111111"
                strokeWidth={0.22}
              />
              <text
                x={scaleBarX + tick.widthMm}
                y={scaleBarY + scaleBarH + 2.8}
                fontSize={1.75}
                fontWeight={600}
                textAnchor="middle"
                fill="#111111"
              >
                {tick.label}
              </text>
            </g>
          ))}
          <text x={scaleBarX} y={scaleBarY + scaleBarH + 2.8} fontSize={1.75} fill="#111111">
            0
          </text>
        </g>

        {/* Downstage / Audience edge label */}
        <text
          data-testid="plot-downstage-label"
          x={g.planX + g.planW - 1.5}
          y={scaleBarY + 2.3}
          fontSize={2.45}
          fontWeight={700}
          textAnchor="end"
          letterSpacing={0.35}
          fill="#111111"
        >
          ▼ DOWNSTAGE / AUDIENCE ▼
        </text>

        <text
          x={g.planX + g.planW - 1.5}
          y={scaleBarY + 5.2}
          fontSize={1.65}
          textAnchor="end"
          fill="#444444"
        >
          {plan.scaleBar.checkText}
        </text>

        {/* Simulated-map / dense / oversize notices (multi-line wrapped, never truncated) */}
        <text
          data-testid="plot-notice-line"
          x={g.planX + 1.5}
          y={noticeStartY}
          fontSize={noticeFontMm}
          fill="#333333"
        >
          {plan.bottomNoticeLines.map((line, i) => (
            <tspan key={i} x={g.planX + 1.5} dy={i === 0 ? 0 : noticeLineH}>
              {line}
            </tspan>
          ))}
        </text>
      </g>

      {/* Right sidebar: Legend */}
      <g className="plot-legend" data-testid="plot-legend">
        <rect
          x={sbX}
          y={legY}
          width={sbW}
          height={legH}
          fill="#ffffff"
          stroke="#111111"
          strokeWidth={0.35}
        />
        <rect x={sbX} y={legY} width={sbW} height={6.2} fill="#f4f4f5" stroke="#111111" strokeWidth={0.35} />
        <text x={legInnerX} y={legY + 4.2} fontSize={2.4} fontWeight={700} fill="#111111">
          LEGEND
        </text>
        <text x={sbX + sbW - 2} y={legY + 4.2} fontSize={2.0} fontWeight={600} textAnchor="end" fill="#444444">
          {`${plan.legend.totalFixtures} fixtures`}
        </text>

        {plan.legend.visibleModels.length === 0 ? (
          <text x={legInnerX} y={legY + 13} fontSize={2.1} fill="#52525b">
            No fixtures placed
          </text>
        ) : (
          plan.legend.visibleModels.map((row, idx) => {
            const ry = legY + 8.0 + idx * 7.2;
            const maxDim = Math.max(row.symbol.size.w, row.symbol.size.d, 0.25);
            const symScale = 4.2 / maxDim;
            return (
              <g key={row.key} data-legend-row={row.key}>
                <g transform={`translate(${legInnerX + 2.8} ${ry + 2.6}) scale(${symScale})`}>
                  {renderSymbolPaths(row.symbol.plan, 0.2 / symScale, false)}
                </g>
                <text x={legInnerX + 7.2} y={ry + 2.1} fontSize={1.95} fontWeight={600} fill="#111111">
                  {truncateToWidth(row.displayName, legInnerW - 16.5, 1.95, true)}
                </text>
                <text x={legInnerX + 7.2} y={ry + 4.4} fontSize={1.6} fill="#52525b">
                  {`${row.wattsEach}${row.wattsEstimated ? '*' : ''} W ea`}
                </text>
                <text
                  x={sbX + sbW - 2}
                  y={ry + 3.0}
                  fontSize={2.1}
                  fontWeight={700}
                  textAnchor="end"
                  fill="#111111"
                >
                  {`×${row.count}`}
                </text>
              </g>
            );
          })
        )}

        {plan.legend.overflowRow && (
          <g>
            <text
              x={legInnerX}
              y={legY + 8.0 + plan.legend.visibleModels.length * 7.2 + 2.5}
              fontSize={1.75}
              fontStyle="italic"
              fill="#444444"
            >
              {`+${plan.legend.overflowRow.hiddenModels} more models (see Instrument Schedule)`}
            </text>
            <text
              x={sbX + sbW - 2}
              y={legY + 8.0 + plan.legend.visibleModels.length * 7.2 + 2.5}
              fontSize={2.0}
              fontWeight={700}
              textAnchor="end"
              fill="#111111"
            >
              {`×${plan.legend.overflowRow.totalCount}`}
            </text>
          </g>
        )}

        {plan.unplacedCount > 0 && (
          <text
            x={legInnerX}
            y={lineStylesY - 1.8}
            fontSize={1.75}
            fontWeight={600}
            fill="#cc0000"
          >
            {`${plan.unplacedCount} unit${plan.unplacedCount === 1 ? '' : 's'} not placed (see sheets)`}
          </text>
        )}

        {/* Line styles key */}
        <g data-testid="plot-line-styles">
          <line x1={sbX} y1={lineStylesY} x2={sbX + sbW} y2={lineStylesY} stroke="#111111" strokeWidth={0.25} />
          <text x={legInnerX} y={lineStylesY + 3.4} fontSize={1.85} fontWeight={700} fill="#3f3f46">
            LINE STYLES
          </text>

          {/* Row 1: Truss | Deck edge */}
          <line x1={legInnerX} y1={lineStylesY + 7.2} x2={legInnerX + 8} y2={lineStylesY + 7.2} stroke="#111111" strokeWidth={0.6} />
          <text x={legInnerX + 9.5} y={lineStylesY + 7.8} fontSize={1.8} fill="#111111">
            Truss
          </text>

          <line
            x1={legInnerX + 31}
            y1={lineStylesY + 7.2}
            x2={legInnerX + 39}
            y2={lineStylesY + 7.2}
            stroke="#52525b"
            strokeWidth={0.35}
            strokeDasharray="2 1"
          />
          <text x={legInnerX + 40.5} y={lineStylesY + 7.8} fontSize={1.8} fill="#111111">
            Deck edge
          </text>

          {/* Row 2: LED wall | PA hang */}
          <rect x={legInnerX} y={lineStylesY + 11.4} width={8} height={1.7} fill="#d4d4d8" stroke="#18181b" strokeWidth={0.35} />
          <text x={legInnerX + 9.5} y={lineStylesY + 12.9} fontSize={1.8} fill="#111111">
            LED wall
          </text>

          <rect x={legInnerX + 31} y={lineStylesY + 11.2} width={4.2} height={2.2} fill="#e4e4e7" stroke="#27272a" strokeWidth={0.3} />
          <line x1={legInnerX + 35.2} y1={lineStylesY + 12.3} x2={legInnerX + 39} y2={lineStylesY + 12.3} stroke="#27272a" strokeWidth={0.3} />
          <text x={legInnerX + 40.5} y={lineStylesY + 12.9} fontSize={1.8} fill="#111111">
            PA hang
          </text>

          {/* Footnote for estimated watts */}
          <text x={legInnerX} y={lineStylesY + 17.5} fontSize={1.55} fill="#52525b">
            * Estimated hardware allowance
          </text>

          {/* Row 3 (when conflicts/overflows exist): red dashed + ! */}
          {plan.legend.hasIssues && (
            <g>
              <circle
                cx={legInnerX + 4}
                cy={lineStylesY + 21.8}
                r={2.0}
                fill="none"
                stroke="#cc0000"
                strokeWidth={0.35}
                strokeDasharray="1.1 0.55"
              />
              <text x={legInnerX + 4} y={lineStylesY + 22.5} fontSize={1.7} fontWeight={700} textAnchor="middle" fill="#cc0000">
                !
              </text>
              <text x={legInnerX + 8.5} y={lineStylesY + 22.4} fontSize={1.75} fontWeight={600} fill="#cc0000">
                DMX conflict / overflow
              </text>
            </g>
          )}
        </g>
      </g>

      {/* Right sidebar: Title Block (bottom right) */}
      <g className="plot-title-block" data-testid="plot-title-block">
        <rect
          x={sbX}
          y={tbY}
          width={sbW}
          height={tbH}
          fill="#ffffff"
          stroke="#111111"
          strokeWidth={0.45}
        />

        {/* Rig / Show name */}
        <rect x={sbX} y={tbY} width={sbW} height={13} fill="#f4f4f5" stroke="#111111" strokeWidth={0.35} />
        <text x={tbInnerX} y={tbY + 3.6} fontSize={1.6} fontWeight={700} fill="#52525b" letterSpacing={0.25}>
          STAGEFORGE PRODUCTION PLOT
        </text>
        <text
          data-testid="plot-title-rig-name"
          x={tbInnerX}
          y={tbY + 9.8}
          fontSize={3.3}
          fontWeight={700}
          fill="#111111"
        >
          {plan.titleBlock.rigName}
        </text>

        {/* Venue */}
        <line x1={sbX} y1={tbY + 20.5} x2={sbX + sbW} y2={tbY + 20.5} stroke="#111111" strokeWidth={0.25} />
        <text x={tbInnerX} y={tbY + 16.0} fontSize={1.55} fontWeight={700} fill="#52525b">
          VENUE
        </text>
        <text data-testid="plot-title-venue" x={tbInnerX} y={tbY + 19.2} fontSize={2.25} fontWeight={600} fill="#111111">
          {plan.titleBlock.venue}
        </text>

        {/* Designer */}
        <line x1={sbX} y1={tbY + 28} x2={sbX + sbW} y2={tbY + 28} stroke="#111111" strokeWidth={0.25} />
        <text x={tbInnerX} y={tbY + 23.5} fontSize={1.55} fontWeight={700} fill="#52525b">
          DESIGNER
        </text>
        <text data-testid="plot-title-designer" x={tbInnerX} y={tbY + 26.7} fontSize={2.25} fontWeight={600} fill="#111111">
          {plan.titleBlock.designer}
        </text>

        {/* Revision | Date */}
        <line x1={sbX} y1={tbY + 36.5} x2={sbX + sbW} y2={tbY + 36.5} stroke="#111111" strokeWidth={0.25} />
        <line x1={sbX + 22} y1={tbY + 28} x2={sbX + 22} y2={tbY + 45} stroke="#111111" strokeWidth={0.25} />
        <text x={tbInnerX} y={tbY + 31.2} fontSize={1.55} fontWeight={700} fill="#52525b">
          REV
        </text>
        <text data-testid="plot-title-revision" x={tbInnerX} y={tbY + 34.8} fontSize={2.4} fontWeight={700} fill="#111111">
          {plan.titleBlock.revision}
        </text>
        <text x={sbX + 24} y={tbY + 31.2} fontSize={1.55} fontWeight={700} fill="#52525b">
          DATE
        </text>
        <text data-testid="plot-title-date" x={sbX + 24} y={tbY + 34.8} fontSize={2.2} fontWeight={600} fill="#111111">
          {plan.titleBlock.date}
        </text>

        {/* Scale | Sheet */}
        <line x1={sbX} y1={tbY + 45} x2={sbX + sbW} y2={tbY + 45} stroke="#111111" strokeWidth={0.3} />
        <text x={tbInnerX} y={tbY + 39.7} fontSize={1.55} fontWeight={700} fill="#52525b">
          SCALE
        </text>
        <text data-testid="plot-title-scale" x={tbInnerX} y={tbY + 43.3} fontSize={2.3} fontWeight={700} fill="#111111">
          {plan.titleBlock.scaleLabel}
        </text>
        <text x={sbX + 24} y={tbY + 39.7} fontSize={1.55} fontWeight={700} fill="#52525b">
          SHEET
        </text>
        <text data-testid="plot-title-sheet" x={sbX + 24} y={tbY + 43.3} fontSize={2.3} fontWeight={700} fill="#111111">
          {plan.titleBlock.sheetLabel}
        </text>

        {/* Disclaimer */}
        <text data-testid="plot-title-disclaimer" x={tbInnerX} y={tbY + 49.0} fontSize={1.8} fill="#27272a">
          {disclaimerLines.map((line, i) => (
            <tspan key={i} x={tbInnerX} dy={i === 0 ? 0 : 2.6}>
              {line}
            </tspan>
          ))}
        </text>
      </g>
    </svg>
  );
};
